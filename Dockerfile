FROM node:9.11-alpine
WORKDIR /1abel
COPY k8s-label /usr/local/bin/
COPY package.json tsconfig.json yarn.lock ./
COPY src/ src/
RUN apk --no-cache add \
      bash \
      curl \
 && curl -LO https://storage.googleapis.com/kubernetes-release/release/$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt)/bin/linux/amd64/kubectl \
 && chmod +x ./kubectl \
 && mv ./kubectl /usr/local/bin/kubectl \
 && yarn
CMD ["tail", "-f", "/dev/null"]
