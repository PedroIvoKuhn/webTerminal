FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    openmpi-bin \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Garante que mpiuser terá sempre o ID de usuário 1000 e grupo 1000
RUN groupadd -g 1000 mpiuser && \
    useradd -u 1000 -g 1000 -m -s /bin/bash mpiuser && \
    usermod -aG sudo mpiuser && \
    echo "mpiuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# --- AJUSTE DE PERMISSÕES E CONFIGURAÇÃO SSH ---

# 1. Garante que o sshd aceite chaves públicas e NÃO senhas
RUN sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config

# 2. Cria a pasta .ssh e APLICA AS PERMISSÕES CORRETAS
RUN mkdir -p /home/mpiuser/.ssh && \
    chmod 700 /home/mpiuser/.ssh && \
    chown -R mpiuser:mpiuser /home/mpiuser/.ssh

# Cria o diretório que o sshd precisa para iniciar
RUN mkdir -p /var/run/sshd && chmod 0755 /var/run/sshd


USER mpiuser
WORKDIR /home/mpiuser

EXPOSE 22

CMD ["/bin/bash", "-c", "sudo /usr/sbin/sshd -D"]