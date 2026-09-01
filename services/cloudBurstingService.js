require('dotenv').config();
const { execSync } = require('child_process');
const os = require('os');

const awsBurster = require('./cloud/awsService');
const azureBurster = require('./cloud/azureService');

const providers = {
    AWS: awsBurster,
    AZURE: azureBurster
};

/**
 * Obtém o módulo burster do provedor especificado
 */
function resolveProvider(providerName) {
    const name = (providerName || process.env.CLOUD_PROVIDER || 'AWS').toUpperCase();
    const burster = providers[name];

    if (!burster) {
        throw new Error(`Provedor de nuvem desconhecido ou não suportado: ${providerName}`);
    }

    return { name, module: burster };
}

/**
 * Valida as credenciais da nuvem antes de tentar qualquer operação
 * @param {string} provider - 'AWS' | 'AZURE'
 * @param {Object} credentials - Objeto com as credenciais
 */
async function validateCredentials(provider, credentials = {}) {
    const { name, module } = resolveProvider(provider);
    return await module.validateCredentials(credentials);
}

/**
 * Gera o comando de join do MicroK8s substituindo pelo IP da interface Tailscale
 */
function generateJoinCommand() {
    console.log("[BURST] Gerando token de join do MicroK8s local...");
    const addNodeOutput = execSync('microk8s add-node').toString();

    const match = addNodeOutput.match(/microk8s join [^\n|\\]+/);
    if (!match) {
        throw new Error("Não foi possível gerar um comando de join válido: " + addNodeOutput);
    }

    let joinCommand = "sudo " + match[0].trim();
    const interfaces = os.networkInterfaces();

    if (interfaces['tailscale0']) {
        const tailscaleIp = interfaces['tailscale0'].find(i => i.family === 'IPv4' || i.family === 4)?.address;
        if (tailscaleIp) {
            joinCommand = joinCommand.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, tailscaleIp);
        }
    }

    return joinCommand;
}

/**
 * Provisiona um novo nó na nuvem informada usando as credenciais passadas
 * @param {Object} options
 * @param {string} options.provider - 'AWS' | 'AZURE'
 * @param {Object} options.credentials - Credenciais da nuvem da sessão
 * @param {string} [options.customJoinCommand] - Comando de join pré-gerado (opcional)
 */
async function addNode({ provider, credentials, customJoinCommand } = {}) {
    const { name, module } = resolveProvider(provider);

    // Validação prévia de credenciais
    const authCheck = await module.validateCredentials(credentials);
    if (!authCheck.valid) {
        throw new Error(`[BURST AUTH ERRO] Falha na validação das credenciais na ${name}: ${authCheck.error}`);
    }

    const joinCommand = customJoinCommand || generateJoinCommand();
    console.log(`[BURST] Adicionando nó na nuvem ${name}...`);

    const nodeId = await module.addNode(joinCommand, credentials);

    return {
        nodeId,
        provider: name
    };
}

/**
 * Remove o nó do Kubernetes e destrói o recurso na nuvem
 */
async function removeNode({ nodeId, provider, credentials, privateDnsOrHost } = {}) {
    const { name, module } = resolveProvider(provider);

    if (privateDnsOrHost) {
        console.log(`[BURST] Ejetando nó (${privateDnsOrHost}) do Kubernetes local...`);
        try {
            execSync(`microk8s kubectl delete node ${privateDnsOrHost}`);
            console.log("[BURST] Nó excluído com sucesso do MicroK8s.");
        } catch (e) {
            console.warn(`[BURST AVISO] Não foi possível remover nó do Kubernetes: ${e.message}`);
        }
    }

    console.log(`[BURST] Destruindo instância ${nodeId} na ${name}...`);
    return await module.removeNode(nodeId, credentials);
}

/**
 * Lista todos os nós de burst ativos na nuvem informada
 */
async function listBurstNodes({ provider, credentials } = {}) {
    const { module } = resolveProvider(provider);
    return await module.listBurstNodes(credentials);
}

module.exports = {
    validateCredentials,
    addNode,
    removeNode,
    listBurstNodes,
    generateJoinCommand
};