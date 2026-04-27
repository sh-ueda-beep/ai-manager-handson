# Lambda の Amazon Linux 2023 ベースには LibreOffice パッケージが無いため、
# Debian slim ベースに AWS Lambda Runtime Interface Client (RIC) を組み合わせる。
# 参考: TS-AI-BOSS/Dockerfile（apt で libreoffice + fonts-noto-cjk をインストール）
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/tmp \
    LANG=C.UTF-8

# LibreOffice 本体・日本語フォントと、aws-lambda-ric のネイティブビルドに必要な
# ツールチェーン一式をインストール。
# AWS 公式 Lambda Container 手順に従い、cmake / build-essential / autoconf /
# automake / libtool / python3 / libcurl (dev) を揃える。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice \
      fonts-noto-cjk \
      fonts-dejavu \
      build-essential \
      cmake \
      python3 \
      autoconf \
      automake \
      libtool \
      libcurl4-openssl-dev \
      unzip \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

WORKDIR /var/task

COPY package.json ./
RUN npm install
COPY handler.ts ./
RUN npx tsc --module nodenext --moduleResolution nodenext --target es2022 --esModuleInterop --skipLibCheck --outDir /var/task handler.ts

# AWS Lambda Runtime Interface Client — Debian 系ベースで Lambda を動かすために必要
ENTRYPOINT ["/var/task/node_modules/.bin/aws-lambda-ric"]
CMD ["handler.handler"]
