const { Socket } = require('engine.io');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.use('/xterm', express.static(path.join(__dirname, 'node_modules/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/xterm-addon-fit')));

io.on('connection', (socket) => {
    console.log('Frontend conectado!');

    socket.on('input', (data)=>{
        console.log(`Input recebido: ${data}`);
        socket.emit('output', '0\r\n');
    });

    socket.on('disconnect', ()=>{
        console.log("Frontend Desconectado!");
    });
});

server.listen(PORT, ()=>{
    console.log(`Servidor rodando em http://localhost:${PORT}`);
})