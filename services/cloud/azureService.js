const { ClientSecretCredential } = require("@azure/identity");
const { ComputeManagementClient } = require("@azure/arm-compute");
const { NetworkManagementClient } = require("@azure/arm-network");
const { ResourceManagementClient } = require("@azure/arm-resources");

/**
 * Cria os clientes e contexto da Azure a partir das credenciais passadas
 */
function getAzureContext(credentials = {}) {
    const tenantId = (credentials.tenantId || process.env.AZURE_TENANT_ID || '').trim();
    const clientId = (credentials.clientId || process.env.AZURE_CLIENT_ID || '').trim();
    const clientSecret = (credentials.clientSecret || process.env.AZURE_CLIENT_SECRET || '').trim();
    const subscriptionId = (credentials.subscriptionId || process.env.AZURE_SUBSCRIPTION_ID || '').trim();

    if (!tenantId || !clientId || !clientSecret || !subscriptionId) {
        throw new Error("Credenciais do Azure estão incompletas.");
    }

    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);

    return {
        resourceGroupName: (credentials.resourceGroupName || process.env.AZURE_RESOURCE_GROUP || 'CloudBurstingRG').trim(),
        location: (credentials.location || process.env.AZURE_LOCATION || 'eastus').trim(),
        vmSize: (credentials.vmSize || process.env.AZURE_VM_SIZE || 'Standard_B2s').trim(),
        vnetName: 'BurstVNet',
        subnetName: 'BurstSubnet',
        subscriptionId,
        credential,
        computeClient: new ComputeManagementClient(credential, subscriptionId),
        networkClient: new NetworkManagementClient(credential, subscriptionId),
        resourceClient: new ResourceManagementClient(credential, subscriptionId)
    };
}

/**
 * Valida as credenciais da Azure tentando consultar o Resource Group
 */
async function validateCredentials(credentials = {}) {
    try {
        const ctx = getAzureContext(credentials);
        // Tenta listar ou checar a existência do Resource Group como teste de autenticação
        await ctx.resourceClient.resourceGroups.checkExistence(ctx.resourceGroupName);
        return {
            valid: true,
            subscriptionId: ctx.subscriptionId,
            resourceGroup: ctx.resourceGroupName
        };
    } catch (error) {
        return {
            valid: false,
            error: error.message
        };
    }
}

async function ensureInfrastructure(ctx) {
    console.log("-> Registrando Providers da Azure (se necessário)...");
    await ctx.resourceClient.providers.register('Microsoft.Network');
    await ctx.resourceClient.providers.register('Microsoft.Compute');

    await ctx.resourceClient.resourceGroups.createOrUpdate(ctx.resourceGroupName, {
        location: ctx.location
    });

    await ctx.networkClient.virtualNetworks.beginCreateOrUpdateAndWait(ctx.resourceGroupName, ctx.vnetName, {
        location: ctx.location,
        addressSpace: {
            addressPrefixes: ['10.0.0.0/16']
        }
    });

    await ctx.networkClient.subnets.beginCreateOrUpdateAndWait(ctx.resourceGroupName, ctx.vnetName, ctx.subnetName, {
        addressPrefix: '10.0.0.0/24'
    });
}

function buildUserDataScript(joinCommand = '', tailscaleKey = process.env.TAILSCALE_AUTH_KEY) {
    let script = `#!/bin/bash
exec > /var/log/burst-init.log 2>&1
set -x

echo "=== INICIANDO CONFIGURACAO DO BURST NODE ==="
date

# Aguarda eventuais locks do apt da inicialização do Ubuntu
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
    echo "Aguardando lock do apt ser liberado..."
    sleep 3
done

apt-get update -y
apt-get install -y curl

# --- Instalando e Configurando o Tailscale ---
echo "--- Instalando Tailscale ---"
curl -fsSL https://tailscale.com/install.sh | sh
`;

    if (tailscaleKey) {
        script += `tailscale up --authkey=${tailscaleKey} --accept-routes --ssh\n`;
        script += `
# Aguarda IP do Tailscale ser configurado na interface
TS_IP=""
for i in {1..30}; do
    TS_IP=$(tailscale ip -4 || true)
    if [ -n "$TS_IP" ]; then
        echo "Tailscale conectado com IP: $TS_IP"
        break
    fi
    sleep 2
done
`;
    }

    if (joinCommand) {
        let finalJoin = joinCommand.includes('--worker') ? joinCommand : `${joinCommand} --worker`;
        script += `
# --- Instalando o MicroK8s ---
echo "--- Instalando MicroK8s snap ---"
for i in {1..5}; do
    snap install microk8s --classic --channel=1.32/stable && break || sleep 5
done

usermod -aG microk8s ubuntu
microk8s status --wait-ready

# Configura o kubelet para anunciar explicitamente o IP do Tailscale ao cluster
if [ -n "$TS_IP" ]; then
    echo "Configurando --node-ip=$TS_IP no kubelet..."
    echo "--node-ip=$TS_IP" >> /var/snap/microk8s/current/args/kubelet
    systemctl restart snap.microk8s.daemon-kubelet || true
    sleep 5
fi

mkdir -p /home/ubuntu/.kube
chown -f -R ubuntu:ubuntu /home/ubuntu/.kube || true

# --- Injetando Comando do Cluster Local ---
echo "--- INICIANDO JOIN COM MICROK8S ---"
date
for i in {1..5}; do
    echo "Tentativa $i de join..."
    ${finalJoin} && break || sleep 5
done

echo "--- JOIN FINALIZADO ---"
date
`;
    }

    return Buffer.from(script).toString('base64');
}

async function addNode(joinCommand = '', credentials = {}, options = {}) {
    const { onProgress, tags = {} } = options;
    const ctx = getAzureContext(credentials);

    console.log("-> Garantindo infraestrutura básica (RG, VNet, Subnet) na Azure...");
    if (onProgress) onProgress(2, "Garantindo infraestrutura básica (RG, VNet, Subnet) na Azure...");
    await ensureInfrastructure(ctx);

    const nodeId = `burst-node-${Date.now()}`;
    const publicIpName = `${nodeId}-ip`;
    const nicName = `${nodeId}-nic`;

    console.log(`-> Criando IP Público: ${publicIpName}...`);
    const publicIp = await ctx.networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(ctx.resourceGroupName, publicIpName, {
        location: ctx.location,
        publicIPAllocationMethod: 'Static',
        sku: { name: 'Standard' }
    });

    console.log(`-> Criando Interface de Rede (NIC): ${nicName}...`);
    const subnet = await ctx.networkClient.subnets.get(ctx.resourceGroupName, ctx.vnetName, ctx.subnetName);
    
    const nic = await ctx.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(ctx.resourceGroupName, nicName, {
        location: ctx.location,
        ipConfigurations: [{
            name: 'ipconfig1',
            subnet: { id: subnet.id },
            publicIPAddress: { id: publicIp.id }
        }]
    });

    const encodedUserData = buildUserDataScript(joinCommand, credentials.tailscaleAuthKey);
    console.log(`-> Criando Máquina Virtual: ${nodeId}...`);
    if (onProgress) onProgress(2, `Criando Máquina Virtual ${nodeId} na Azure...`);
    
    const adminPassword = `Burst@${Math.random().toString(36).slice(2)}${Date.now()}!`;

    const vmTags = {
        Role: "CloudBurstingWorker",
        ManagedBy: "TerminalWeb"
    };
    if (tags.jobId) vmTags.JobId = String(tags.jobId);
    if (tags.socketId) vmTags.SocketId = String(tags.socketId);

    const vmParameters = {
        location: ctx.location,
        hardwareProfile: {
            vmSize: ctx.vmSize
        },
        osProfile: {
            computerName: nodeId,
            adminUsername: 'ubuntu',
            adminPassword: adminPassword,
            customData: encodedUserData
        },
        storageProfile: {
            imageReference: {
                publisher: 'Canonical',
                offer: '0001-com-ubuntu-server-jammy',
                sku: '22_04-lts-gen2',
                version: 'latest'
            },
            osDisk: {
                name: `${nodeId}-osdisk`,
                caching: 'ReadWrite',
                createOption: 'FromImage',
                managedDisk: {
                    storageAccountType: 'Standard_LRS'
                }
            }
        },
        networkProfile: {
            networkInterfaces: [{ id: nic.id, primary: true }]
        },
        tags: vmTags
    };

    try {
        await ctx.computeClient.virtualMachines.beginCreateOrUpdateAndWait(ctx.resourceGroupName, nodeId, vmParameters);
        console.log(`[SUCESSO] Instância Azure criada! ID/Nome: ${nodeId}`);
        if (onProgress) onProgress(3, `Instância criada (${nodeId}). Conectando via Tailscale e iniciando MicroK8s...`);
        return nodeId;
    } catch (error) {
        console.error("[ERRO] Falha ao criar a instância no Azure:", error);
        throw error;
    }
}

async function removeNode(nodeId, credentials = {}) {
    const ctx = getAzureContext(credentials);
    try {
        console.log(`-> Solicitando encerramento da VM ${nodeId} e recursos associados...`);
        
        await ctx.computeClient.virtualMachines.beginDeleteAndWait(ctx.resourceGroupName, nodeId);
        await ctx.networkClient.networkInterfaces.beginDeleteAndWait(ctx.resourceGroupName, `${nodeId}-nic`);
        await ctx.networkClient.publicIPAddresses.beginDeleteAndWait(ctx.resourceGroupName, `${nodeId}-ip`);

        try {
            await ctx.computeClient.disks.beginDeleteAndWait(ctx.resourceGroupName, `${nodeId}-osdisk`);
        } catch (diskErr) {
            console.log(`Aviso: Disco já removido ou inacessível. ${diskErr.message}`);
        }

        console.log(`[SUCESSO] Instância ${nodeId} e seus recursos removidos do Azure.`);
        return true;
    } catch (error) {
        console.error(`[ERRO] Falha ao remover recursos do nó ${nodeId}:`, error);
        throw error;
    }
}

async function listBurstNodes(credentials = {}) {
    const ctx = getAzureContext(credentials);
    try {
        const instances = [];
        const vms = ctx.computeClient.virtualMachines.list(ctx.resourceGroupName);
        
        for await (const vm of vms) {
            if (vm.tags && vm.tags.Role === 'CloudBurstingWorker') {
                const vmDetails = await ctx.computeClient.virtualMachines.instanceView(ctx.resourceGroupName, vm.name);
                const states = vmDetails.statuses.map(s => s.code);
                const isRunning = states.includes('PowerState/running');
                const isCreating = states.includes('ProvisioningState/creating');

                if (states.includes('ProvisioningState/deleting') || states.includes('ProvisioningState/deleted')) {
                    continue;
                }

                let currentState = 'unknown';
                if (isRunning) currentState = 'running';
                else if (isCreating) currentState = 'pending';
                else currentState = states[1] || states[0] || 'stopped';

                instances.push({
                    id: vm.name,
                    state: currentState,
                    type: vm.hardwareProfile.vmSize,
                    launchTime: 'N/A',
                    publicIp: 'N/A',
                    privateDns: vm.name
                });
            }
        }

        return instances;
    } catch (error) {
        console.error("[ERRO] Falha ao listar as instâncias no Azure:", error);
        throw error;
    }
}

module.exports = {
    validateCredentials,
    addNode,
    removeNode,
    listBurstNodes
};