# Terminal Web para Clusters MPI On-Demand

Uma aplicação web que provisiona, sob demanda, ambientes de múltiplos nós para o ensino e a prática de computação paralela com MPI. 
A solução utiliza Kubernetes para orquestrar contêineres dinamicamente, oferecendo a cada usuário um cluster privado e isolado, acessível diretamente pelo navegador.

## Recursos:

- **Provisionamento On-Demand:** Crie ambientes de múltiplos nós em segundos.
- **Configuração pelo Usuário:** Especifique o número de máquinas virtuais necessárias para cada sessão.
- **Terminal Web Interativo:** Acesso shell completo a um nó mestre diretamente no navegador, com tecnologia Xterm.js.
- **Isolamento de Sessão:** Cada sessão de usuário cria recursos Kubernetes (Pods, Service, Secret) com nomes únicos, garantindo o isolamento.
- **Segurança:** Um par de chaves SSH novo e exclusivo é gerado para cada sessão, garantindo que apenas os nós de um mesmo ambiente possam se comunicar.
- **Acesso Simplificado:** Conectividade SSH pré-configurada entre os nós do ambiente, com apelidos simples como master e worker-1.
- **Limpeza Automática:** Todos os recursos criados no Kubernetes são automaticamente removidos ao final da sessão, evitando o desperdício de recursos.

## Tecnologias Utilizadas
- **Backend:** Node.js, Express.js, Socket.IO
- **Frontend:** HTML5, CSS3, JavaScript, Xterm.js
- **Orquestração e Infraestrutura:**
  - **Kubernetes:** Para orquestrar os contêineres e a rede.
  - **Docker:** Para construir a imagem dos nós computacionais.
  - **@kubernetes/client-node:** Biblioteca cliente para comunicação com a API do Kubernetes.
  - **node-forge:** Para geração dinâmica das chaves SSH em tempo real.

## Arquitetura
O projeto segue uma arquitetura de três camadas que operam em uma rede local:

1. **Infraestrutura (Cluster Kubernetes):** A camada de execução. Um cluster Kubernetes (seja um ambiente de nó único como Docker Desktop ou um cluster físico de múltiplos nós) que executa os contêineres que compõem os ambientes dos usuários.
2. **Backend (Servidor de Orquestração):** O núcleo da aplicação. Ele escuta os pedidos do frontend, atua como um cliente da API do Kubernetes para criar/destruir os ambientes e serve como um proxy para o fluxo de dados do terminal.
3. **Frontend (Cliente):** Uma interface web leve responsável por capturar a requisição do usuário e renderizar o terminal.

<img width="1097" height="489" alt="image" src="https://github.com/user-attachments/assets/e7a416b6-591d-4606-9946-14395fadcba6" />


## Instalação e Uso
Siga os passos abaixo para executar o projeto localmente.

**Pré-requisitos**
- Node.js (versão 18 ou superior)
- Docker Desktop
  - Certifique-se de que o Kubernetes esteja habilitado nas configurações do Docker Desktop (`Settings > Kubernetes > Enable Kubernetes`).

Passos
1. Clone o Repositório
```
git clone https://github.com/seu-usuario/seu-repositorio.git
cd seu-repositorio
```
2. Instale as Dependências
```
npm install
```
3. Construa a Imagem Docker dos Nós MPI
Este comando usa o Dockerfile para criar a imagem Docker que será usada para cada nó do cluster do usuário.
```
docker build -t terminal-web:latest -f Dockerfile.mpi .
```
4. Aplique as Permissões no Kubernetes
Este comando aplica as regras de RBAC (Role-Based Access Control), permitindo que a aplicação gerencie os recursos necessários no cluster.
```
# Certifique-se que seu kubectl está apontando para o cluster do Docker Desktop
kubectl apply -f rbac.yaml
```
5. Inicie o Servidor
```
npm start
```
6. Acesse a Aplicação
Abra seu navegador e acesse http://localhost:3000.
