# DocMind 部署指南

本地一条命令部署到远程服务器，**全程不需要手动 SSH 登录服务器**。
原理：在本地创建一个指向服务器的 Docker context，`deploy.sh` 通过 SSH 把构建
和运行都交给服务器上的 Docker daemon。镜像和数据卷都在远程；API key 只读自你
本地的 `packages/server/.env`，不会被复制到服务器磁盘。

```
本地 ./deploy.sh ──SSH──> 服务器 Docker daemon: 构建镜像 + 起容器 + 持久卷
访问: http://服务器IP:8080   (只对外暴露前端这一个端口)
```

## 一次性准备

1. **配置后端环境变量**（密钥留在本地）：
   ```bash
   cp packages/server/.env.example packages/server/.env
   # 编辑 .env，至少填 ANTHROPIC_API_KEY 或 ZHIPU_API_KEY
   ```

2. **打通到服务器的 SSH 免密**：
   ```bash
   ssh-copy-id user@服务器IP
   ```

3. **运行一次性 setup**（在服务器装 Docker + 在本地建 context，唯一会用到 SSH 的一步）：
   ```bash
   ./scripts/setup-remote.sh user@服务器IP
   ```
   > 若提示需要刷新 docker 用户组，按提示重连一次 SSH 即可。

4. 服务器安全组 / 防火墙放行 **8080** 端口。

## 日常部署 / 更新

改完代码后，本地执行：

```bash
./deploy.sh
```

它会在远程构建镜像、滚动重启容器，并打印访问地址。**不需要登录服务器。**

- 换端口：`CLIENT_PORT=9000 ./deploy.sh`
- 换 context 名：`DOCKER_CONTEXT=foo ./deploy.sh`

## 常用运维命令（都带 `--context`，依然不用 SSH）

```bash
# 查看运行状态
docker --context docmind compose -f docker-compose.prod.yml ps

# 查看日志
docker --context docmind compose -f docker-compose.prod.yml logs -f server

# 停止 / 启动
docker --context docmind compose -f docker-compose.prod.yml down
docker --context docmind compose -f docker-compose.prod.yml up -d
```

## 数据持久化

以下数据存在服务器上的命名卷中，重新部署不会丢失：

| 卷 | 内容 |
|---|---|
| `server_data` | SQLite（记忆 / 文档元数据 / 评测） `/app/data` |
| `uploads` | 上传的原始文件 `/app/uploads` |
| `chroma_data` | ChromaDB 向量库 |

## 端口与暴露

只有 **client（8080→80）** 对外发布。`server`（3001）和 `chroma`（8000）仅在
compose 内网可达，前端通过 nginx 把 `/api` 反代到 `server:3001`。

## 加 HTTPS / 域名（以后）

当前是 `http://IP:8080`。有域名后，推荐在服务器前面加一个 Caddy 反向代理自动签
Let's Encrypt 证书，把 80/443 转发到 `client:80`。届时再补这一层即可，不影响现有方案。

## 故障排查

- `Docker context 'docmind' not found` → 先跑 `./scripts/setup-remote.sh`。
- `Missing packages/server/.env` → 见上面第 1 步。
- 页面打开但聊天/文档报错 → 查 server 日志，多半是 `.env` 里 API key 没填或额度问题。
