const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const k8s = require('@kubernetes/client-node');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const kc = new k8s.KubeConfig();

if (process.env.KUBERNETES_SERVICE_HOST){
    console.log('Rodando dentro do cluster, usando config de cluster');
    kc.loadFromCluster();
} else {
    console.log('Rodando fora do cluster, usando config padrão');
    kc.loadFromDefault();
}

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sExec = new k8s.Exec(kc);
const namespace = 'default';

const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/xterm', express.static(path.join(__dirname, 'node_modules/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/xterm-addon-fit')));

async function waitForPodRunning(api, name, namespace, timeoutSeconds) {
    const startTime = Date.now();
    console.log(`Esperando o Pod ${name} ficar 'Running'...`);

    while (Date.now() - startTime < timeoutSeconds * 1000) {
        try {
            const res = await api.readNamespacedPodStatus(name, namespace);
            if (res.body.status.phase === 'Running') {
                console.log(`Pod ${name} está 'Running'.`);
                return;
            }
        } catch (err) {
            // Ignora erros 404, pois o pod pode não estar visível na API ainda
            if (err.statusCode !== 404) {
                throw err;
            }
        }
        // Espera 1 segundo antes de tentar novamente
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Tempo limite excedido esperando pelo Pod ${name}`);
}

io.on('connection', async (socket) => {
    console.log(`Frontend conectado: ${socket.id}`);

    const podName = `terminal-pod-${socket.id.toLowerCase().replace('_','-')}`;
    const podManifest = {
        metadata: {
            name: podName,
            labels: { app: 'web-terminal-session' }
        },
        spec: {
            serviceAccountName: 'terminal-backend-sa',
            containers: [{
                name: 'shell-container',
                image: 'web-terminal-backend:latest',
                imagePullPolicy: 'Never',
                command: ['/bin/sh', '-c', 'tail -f /dev/null'],
            }],
            restartPolicy: 'Never'
        }
    }

    try {
        console.log(`Criando Pod: ${podName}`);
        await k8sApi.createNamespacedPod(namespace, podManifest);

        await waitForPodRunning(k8sApi, podName, namespace, 60);
        console.log(`Pod ${podName} está rodando.`);
        
        const command = ['/bin/sh'];
        const execWs = await k8sExec.exec(namespace, podName, 'shell-container', command, process.stdout, process.stderr, process.stdin, true, (status) => {
            console.log('Sessão exec encerrada com status:', status);
            socket.emit('output', '\r\n[Sessão no Pod encerrada]');
            deletePod(podName);
        });

        // cliente -> pod
        socket.on('input', (data) => {
            if (execWs && execWs.readyState === 1) { // 1 = OPEN
                // Adiciona o caractere de nova linha para executar o comando
                const command = data + '\n';

                // O formato para o stream de exec é [channel, ...data]
                // 0 = stdin, 1 = stdout, 2 = stderr
                const buffer = Buffer.from('\x00' + command); // Adiciona o canal 0 (stdin)
                execWs.send(buffer);
            }
        });

        // pod -> cliente
        execWs.onmessage = (event) => {
            const data = event.data.toString().substring(1);
            socket.emit('output', data);
        };

        execWs.onclose = () => {
            console.log(`WebSocket para ${podName} fechado.`);
        }

        socket.on('disconnect', () => {
            console.log(`Frontend ${socket.id} desconectado.`);
            deletePod(podName);
        })

    } catch (err) {
        console.error('Erro no cilco de vida do Pod:', err);
        socket.emit('output', `\r\n[ERRO DO BACKEND]: não foi possível inciar a sessão.\r\n${err.message}`);
        deletePod(podName);
    }
});

async function deletePod(podName) {
    try {
        console.log(`Deletando Pod: ${podName}`);
        await k8sApi.deleteNamespacedPod(podName, namespace);
    } catch (err) {
        if (err.body && err.body.code === 404) {
            console.log(`Pod ${podName} já não existia.`)
        } else {
            console.error(`Erro ao deletar o Pod ${podName}:`, err.body ? err.body.message : err);
        }
    }
}

server.listen(PORT, ()=>{
    console.log(`Servidor rodando em http://localhost:${PORT}`);
})