const socket = io();

// --- Elementos da Página ---
const setupContainer = document.getElementById('setup-container');
const terminalContainer = document.getElementById('terminal-container');
const setupForm = document.getElementById('setup-form');
const numMachinesInput = document.getElementById('num-machines');

// --- Configuração do Terminal ---
const term = new Terminal({
    cursorBlink: true,
    theme: {
        background: '#1e1e1e'
    }
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

// --- Lógica de Inicialização ---

// Função que esconde o formulário e mostra/configura o terminal
function initializeTerminal() {
    setupContainer.style.display = 'none';
    terminalContainer.style.display = 'block';

    term.open(document.getElementById('terminal'));
    fitAddon.fit();
    window.addEventListener('resize', () => fitAddon.fit());
}

// Lida com o envio do formulário de configuração inicial
setupForm.addEventListener('submit', (e) => {
    // 1. Previne o recarregamento da página
    e.preventDefault(); 
    
    const numMachines = parseInt(numMachinesInput.value, 10);

    if (numMachines > 0) {
        // 2. Envia o número de máquinas para o backend
        socket.emit('start-session', { numMachines });
        
        // 3. Mostra o terminal para o usuário
        initializeTerminal();
    }
});


// --- Lógica de Interação com o Terminal (Pós-inicialização) ---

// Envia cada tecla/dado diretamente para o backend
term.onData(data => {
    socket.emit('input', data);
});

// Apenas escreve na tela o que o backend mandar
socket.on('output', data => {
    term.write(data);
});

socket.on('session-ready', (data) => {
    const machineList = document.getElementById('machine-list');
    machineList.innerHTML = ''; // Limpa a lista para garantir

    // Para cada apelido recebido, cria um item <li> e o adiciona à lista <ul>
    data.aliases.forEach(alias => {
        const listItem = document.createElement('li');
        listItem.textContent = alias;
        machineList.appendChild(listItem);
    });
});

// Lida com erros de conexão para informar o usuário
socket.on('connect_error', (err) => {
    console.error(`Erro de conexão: ${err.message}`);
    term.write(`\r\n[ERRO DE CONEXÃO]: ${err.message}`);
});