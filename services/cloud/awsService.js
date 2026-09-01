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
sudo apt-get update -y
sudo apt-get install -y curl

# --- Instalando e Configurando o Tailscale ---
curl -fsSL https://tailscale.com/install.sh | sh
`;

    if (tailscaleKey) {
        script += `sudo tailscale up --authkey=${tailscaleKey} --accept-routes --ssh\n`;
    } else {
        console.warn("AVISO: TAILSCALE_AUTH_KEY não definido. Instância subirá sem VPN.");
    }

    if (joinCommand) {
        script += `\n# --- Instalando o MicroK8s ---\n`;
        script += `sudo snap install microk8s --classic --channel=1.32/stable\n`;
        script += `sudo usermod -aG microk8s ubuntu\n`;
        script += `sudo microk8s status --wait-ready\n`;
        script += `mkdir -p /home/ubuntu/.kube\n`;
        script += `sudo chown -f -R ubuntu /home/ubuntu/.kube\n`;

        script += `\n# --- Injetando Comando do Cluster Local ---\n`;
        script += `echo "--- INICIANDO JOIN COM MICROK8S ---"\n`;
        let finalJoin = joinCommand.includes('--worker') ? joinCommand : `${joinCommand} --worker`;
        script += `${finalJoin}\n`;
        script += `echo "--- JOIN FINALIZADO ---"\n`;
    }

    return Buffer.from(script).toString('base64');
}

async function addNode(joinCommand = '', credentials = {}) {
    const client = createEc2Client(credentials);
    const instanceType = credentials.instanceType || process.env.INSTANCE_TYPE || 't2.micro';
    const keyPairName = credentials.keyPairName || process.env.AWS_KEY_PAIR_NAME;

    console.log("-> Buscando a AMI mais recente (Ubuntu 22.04 LTS)...");
    const amiId = await getLatestUbuntuAmi(client);
    console.log(`-> AMI encontrada: ${amiId}`);

    const encodedUserData = buildUserDataScript(joinCommand, credentials.tailscaleAuthKey);

    const params = {
        ImageId: amiId,
        InstanceType: instanceType,
        MinCount: 1,
        MaxCount: 1,
        UserData: encodedUserData,
        TagSpecifications: [
            {
                ResourceType: "instance",
                Tags: [
                    { Key: "Name", Value: "BurstNode" },
                    { Key: "Role", Value: "CloudBurstingWorker" }
                ]
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