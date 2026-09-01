const { execSync } = require("child_process");
const os = require('os');

const awsBurster = require('./cloud/awsService');
const azureBurster = require('./cloud/azureService');

const delay = (ms) => new Promise(res => setTimeout(res, ms));

function validateCredentials(provider) {
    if (provider === 'AZURE') {
        if (!process.env.AZURE_TENANT_ID || !process.env.AZURE_CLIENT_ID) {
            console.error("[ERRO] Credenciais do Azure não encontradas no arquivo .env");
            process.exit(1);
        }
        return azureBurster;
    }

    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
        console.error("[ERRO] Credenciais da AWS não encontradas no arquivo .env");
        process.exit(1);
    }
    return awsBurster;
}

function generateJoinCommand() {
    console.log("Gerando token de join do MicroK8s no cluster local...");
    const addNodeOutput = execSync('microk8s add-node').toString();

    // linha de comando que o worker precisa rodar
    const match = addNodeOutput.match(/microk8s join [^\n|\\]+/);
    if (!match) {
        throw new Error("Não foi possível gerar um comando de join válido para o cluster a partir do output: " + addNodeOutput);
    }

    let joinCommand = "sudo " + match[0].trim();
    const interfaces = os.networkInterfaces();

    if (interfaces['tailscale0']) {
        const tailscaleIp = interfaces['tailscale0'].find(i => i.family === 'IPv4' || i.family === 4).address;
        joinCommand = joinCommand.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, tailscaleIp);
    }

    return joinCommand;
}

async function main() {
    console.log("=========================================");
    console.log("   MECANISMO DE CLOUD BURSTING");
    console.log("=========================================\n");

    const provider = (process.env.CLOUD_PROVIDER || 'AWS').toUpperCase();
    console.log(`[INFO] Provedor de Nuvem selecionado: ${provider}\n`);

    const burster = validateCredentials(provider);    
    let clusterNodes = [];

    try {
        console.log(">>> PICO DE DEMANDA DETECTADO <<<");
        console.log("Adicionando recursos na nuvem pública...\n");

        
        const joinCommand = generateJoinCommand();
        console.log("Comando de join gerado:", joinCommand);

        // 1 nova máquina passando o comando dinâmico
        const newNodeId = await burster.addNode(joinCommand);

        console.log("\nAguardando 10 segundos para a máquina iniciar...");
        await delay(10000); // Aguarda a API da aws atualizar os estados

        // Lista as maquinas no ar
        console.log("\n-> Verificando status do cluster na AWS...");
        clusterNodes = await burster.listBurstNodes();

        console.log("==== NÓS ATUAIS ====");
        console.table(clusterNodes);
        console.log("====================\n");

        console.log("\n>>> MÁQUINA INICIADA E PROCESSO ALOCADO <<<");
        console.log("O nó está operando na nuvem. Pressione 'y' e dê Enter para simular o fim da demanda e matar a máquina...");

        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        await new Promise(resolve => {
            readline.on('line', (input) => {
                if (input.toLowerCase().trim() === 'y') {
                    resolve();
                } else {
                    console.log("Comando não reconhecido. Digite 'y' e Enter para finalizar a máquina.");
                }
            });
        });
        readline.close();

        console.log("\n>>> DEMANDA NORMALIZADA <<<");
        console.log("Removendo recursos excedentes do Cluster e da AWS...\n");

        // qual nó no K8S para dar DELETE
        clusterNodes = await burster.listBurstNodes();
        const nodeToKill = clusterNodes.find(n => n.id === newNodeId);
        if (nodeToKill && nodeToKill.privateDns) {
            console.log(`Removendo Node (${nodeToKill.privateDns}) do Microk8s...`);
            try {
                execSync(`microk8s kubectl delete node ${nodeToKill.privateDns}`);
                console.log("[SUCESSO] Nó ejetado do Kubernetes local e workloads evacuados.");
            } catch (e) {
                console.log("[AVISO] Não foi possivel excluir o nó do MicroK8s (talvez ainda não tivesse sincronizado): " + e.message);
            }
        }

        // Destruir a máquina EC2 chamando o método
        await burster.removeNode(newNodeId);

        console.log("\nBurst finalizado e recursos removidos com sucesso!");

    } catch (error) {
        console.error("\n[ERRO CRÍTICO] Falha durante a operação de burst:", error);
    }
}

module.exports = { validateCredentials };