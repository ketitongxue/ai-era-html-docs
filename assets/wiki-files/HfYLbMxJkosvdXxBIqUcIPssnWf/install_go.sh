#!/bin/bash

# 根据需要修改自己要安装的版本号
GOVERSION=go1.24.2
GODOWNLOADNAME=$GOVERSION.linux-amd64.tar.gz

echo $GODOWNLOADNAME

sudo mkdir -p /usr/local/src/go/

wget -c https://golang.google.cn/dl/$GODOWNLOADNAME; tar -C /usr/local/src/go/ -xzf $GODOWNLOADNAME; mv /usr/local/src/go/go/ /usr/local/src/go/$GOVERSION

tee -a $HOME/.bashrc <<'EOF'
# Go envs
export GOVERSION=${GOVERSION-go1.24.2} # Go 版本设置
export GO_INSTALL_DIR=/usr/local/src/go # Go 安装目录
export GOROOT=$GO_INSTALL_DIR/$GOVERSION # GOROOT 设置
export GOPATH=$HOME/golang # GOPATH 设置
export PATH=$GOROOT/bin:$GOPATH/bin:$PATH # 添加 PATH 路径
export GOPROXY=https://goproxy.cn,direct # 安装 Go 模块时，代理服务器设置
export GOPRIVATE=
export GOSUMDB=off # 关闭校验 Go 依赖包的哈希值
EOF

source ~/.bashrc

go version