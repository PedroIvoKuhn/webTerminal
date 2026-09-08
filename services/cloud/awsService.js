const { 
    EC2Client, 
    RunInstancesCommand, 
    TerminateInstancesCommand, 
    DescribeInstancesCommand, 
    DescribeImagesCommand,
    GetCallerIdentityCommand 
} = require("@aws-sdk/client-ec2");
const { STSClient, GetCallerIdentityCommand: STSGetCallerIdentityCommand } = require("@aws-sdk/client-sts");

/**
 * Cria o cliente EC2 a partir das credenciais passadas
 */
function createEc2Client(credentials = {}) {
    const region = credentials.region || process.env.AWS_REGION || 'sa-east-1';
    const config = { region };

    if (credentials.accessKeyId && credentials.secretAccessKey) {
        config.credentials = {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken
        };
    }

    return new EC2Client(config);
}

/**
 * Testa e valida se as credenciais da AWS são válidas
 */
async function validateCredentials(credentials = {}) {
    const region = credentials.region || process.env.AWS_REGION || 'sa-east-1';
    const stsConfig = { region };

    if (credentials.accessKeyId && credentials.secretAccessKey) {
        stsConfig.credentials = {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken
        };
    }

    try {
        const sts = new STSClient(stsConfig);
        const identity = await sts.send(new STSGetCallerIdentityCommand({}));
        return {
            valid: true,
            account: identity.Account,
            arn: identity.Arn
        };
    } catch (error) {
        return {
            valid: false,
            error: error.message
        };
    }
}

async function getLatestUbuntuAmi(client) {
    try {
        const command = new DescribeImagesCommand({
            Owners: ['099720109477'],
            Filters: [
                { Name: 'name', Values: ['ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*'] },
                { Name: 'state', Values: ['available'] },
                { Name: 'architecture', Values: ['x86_64'] }
            ]
        });

        const response = await client.send(command);
        const sortedImages = response.Images.sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate));
        return sortedImages[0].ImageId;
    } catch (error) {
        console.error("Erro ao buscar a AMI do Ubuntu:", error);
        throw error;
    }
}

function buildUserDataScript(joinCommand = '', tailscaleKey = process.env.TAILSCALE_AUTH_KEY) {
    let script = `#!/bin/bash
exec > /var/log/burst-init.log 2>&1
set -x

echo "=== INICIANDO CONFIGURACAO DO BURST NODE AWS ==="
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
    } else {
        console.warn("AVISO: TAILSCALE_AUTH_KEY não definido. Instância subirá sem VPN.");
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
    const client = createEc2Client(credentials);
    const instanceType = credentials.instanceType || process.env.INSTANCE_TYPE || 't2.micro';
    const keyPairName = credentials.keyPairName || process.env.AWS_KEY_PAIR_NAME;

    console.log("-> Buscando a AMI mais recente (Ubuntu 22.04 LTS)...");
    const amiId = await getLatestUbuntuAmi(client);
    console.log(`-> AMI encontrada: ${amiId}`);

    const encodedUserData = buildUserDataScript(joinCommand, credentials.tailscaleAuthKey);

    const tagList = [
        { Key: "Name", Value: "BurstNode" },
        { Key: "Role", Value: "CloudBurstingWorker" },
        { Key: "ManagedBy", Value: "TerminalWeb" }
    ];
    if (tags.jobId) tagList.push({ Key: "JobId", Value: String(tags.jobId) });
    if (tags.socketId) tagList.push({ Key: "SocketId", Value: String(tags.socketId) });

    const params = {
        ImageId: amiId,
        InstanceType: instanceType,
        MinCount: 1,
        MaxCount: 1,
        UserData: encodedUserData,
        TagSpecifications: [
            {
                ResourceType: "instance",
                Tags: tagList
            }
        ]
    };

    if (keyPairName) {
        params.KeyName = keyPairName;
    }

    try {
        const command = new RunInstancesCommand(params);
        const response = await client.send(command);
        const instanceId = response.Instances[0].InstanceId;
        console.log(`[SUCESSO] Instância criada! ID: ${instanceId}`);
        if (onProgress) onProgress(3, `Instância criada (${instanceId}). Conectando via Tailscale e iniciando MicroK8s...`);
        return instanceId;
    } catch (error) {
        console.error("[ERRO] Falha ao criar a instância:", error);
        throw error;
    }
}

async function removeNode(instanceId, credentials = {}) {
    const client = createEc2Client(credentials);
    try {
        console.log(`-> Solicitando encerramento da instância ${instanceId}...`);
        const command = new TerminateInstancesCommand({ InstanceIds: [instanceId] });
        const response = await client.send(command);

        const state = response.TerminatingInstances[0].CurrentState.Name;
        console.log(`[SUCESSO] Instância ${instanceId} agora está em estado: ${state}`);
        return true;
    } catch (error) {
        console.error(`[ERRO] Falha ao remover a instância ${instanceId}:`, error);
        throw error;
    }
}

async function listBurstNodes(credentials = {}) {
    const client = createEc2Client(credentials);
    try {
        const command = new DescribeInstancesCommand({
            Filters: [
                { Name: 'tag:Role', Values: ['CloudBurstingWorker'] },
                { Name: 'instance-state-name', Values: ['running', 'pending'] }
            ]
        });
        const response = await client.send(command);

        const instances = [];
        response.Reservations.forEach(r => {
            r.Instances.forEach(i => {
                instances.push({
                    id: i.InstanceId,
                    state: i.State.Name,
                    type: i.InstanceType,
                    launchTime: i.LaunchTime,
                    publicIp: i.PublicIpAddress || 'N/A',
                    privateDns: (i.PrivateDnsName || '').split('.')[0]
                });
            });
        });

        return instances;
    } catch (error) {
        console.error("[ERRO] Falha ao listar as instâncias:", error);
        throw error;
    }
}

module.exports = {
    validateCredentials,
    addNode,
    removeNode,
    listBurstNodes
};