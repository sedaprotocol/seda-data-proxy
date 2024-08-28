ARG VARIANT=latest
FROM oven/bun:${VARIANT}

RUN apt-get update
RUN chsh -s $(which bash) bun
RUN echo 'export PS1="\e[01;32m\u\e[m:\e[01;34m\w\e[m\$ "' >> /home/bun/.bashrc

USER bun
