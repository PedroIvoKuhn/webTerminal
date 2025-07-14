const socket = io();

const term = new Terminal({
    cursorBlink: true,
    theme: {
        background: '#1e1e1e'
    }
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

term.open(document.getElementById('terminal'));
fitAddon.fit();

term.write('Bem-vindo ao Terminal Web.\r\nDigite algo e pressione Enter:\r\n\r\n$ ');

let currentInput = '';


term.onData(data => {
    // Tecla Enter (geralmente \r no xterm.js)
    if (data === '\r') {
        term.write('\r\nProcessando...\r\n');
        socket.emit('input', currentInput); 
        currentInput = '';
    
    // Tecla Backspace (geralmente \x7f)
    } else if (data === '\x7f') {
        if (currentInput.length > 0) {
            term.write('\b \b'); 
            currentInput = currentInput.slice(0, -1);
        }
    
    // Teclas normais
    } else {
        currentInput += data;
        //mostra o que o usuário digitou
        term.write(data); 
    }
});

// saída do backend
socket.on('output', data => {
    term.write(data); 
    term.write('$ ');
});