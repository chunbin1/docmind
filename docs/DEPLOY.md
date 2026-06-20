# DocMind 部署指南

本地一条命令 `./deploy.sh` 部署到远程服务器，**全程不需要手动 SSH 登录服务器**。

原理：本地建一个指向服务器的 Docker context，`deploy.sh` 通过 SSH 把构建和运行都交给
服务器上的 Docker daemon。镜像和数据卷都在远程；密钥只读自本地的 `.env.prod`，不写入
服务器磁盘、不进镜像、不进 git（详见末尾「密钥是怎么到服务器的」）。

## 架构（生产）

```
浏览器  https://docmind.cbsama.uk
  └─ Cloudflare（受信任证书 / 强制 HTTPS / CDN / 隐藏源站 IP）
       └─ 服务器 host nginx :443（自签名源站证书，Cloudflare SSL 模式 = Full）
            └─ 127.0.0.1:8080  client 容器（nginx，仅监听回环，公网不可直连）
                 ├─ /            → SPA
                 └─ /api → server 容器 :3001 → ChromaDB 容器 :8000
```

- 三个容器由 `docker-compose.prod.yml` 编排：`client`(8080→80)、`server`(3001)、`chroma`(8000)。
- **只有 client 暴露端口，且绑定 `127.0.0.1`**：公网只能经 Cloudflare→host nginx 访问，无法直连 `IP:8080`。

---

## 一、一次性准备

### 1. 配置生产环境变量 `packages/server/.env.prod`
与本地开发的 `.env` **分开**（生产/本地各自的 GitHub OAuth、域名、密钥互不干扰）。已被 `.gitignore` 忽略。

```bash
cp packages/server/.env.example packages/server/.env.prod
```

需要填：

| 变量 | 说明 |
|---|---|
| `ZHIPU_API_KEY`（或 `ANTHROPIC_API_KEY`） | LLM 提供方 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | **生产** GitHub OAuth App 凭证（见下） |
| `APP_URL` | `https://docmind.cbsama.uk`（无尾斜杠）。决定 OAuth 回调、登录后跳转、cookie 是否 `secure` |
| `COOKIE_SECRET` | 会话 cookie 签名密钥，**设一个稳定值**（`openssl rand -hex 32`），否则重启后所有人被登出 |

> `CHROMA_URL` 不用填——`docker-compose.prod.yml` 会注入 `http://chroma:8000`。

### 2. 创建生产 GitHub OAuth App
[github.com/settings/developers](https://github.com/settings/developers) → New OAuth App：

| 字段 | 值 |
|---|---|
| Homepage URL | `https://docmind.cbsama.uk` |
| **Authorization callback URL** | `https://docmind.cbsama.uk/api/auth/github/callback` |

> GitHub OAuth App 只能有一个回调地址，所以**本地和生产各建一个 App**（本地回调填 `http://localhost:5173/...`，写在本地 `.env`）。

### 3. 打通 SSH 免密 + 建 Docker context（唯一会用到 SSH 的一步）
```bash
ssh-copy-id -p <端口> root@<服务器IP>
./scripts/setup-remote.sh root@<服务器IP>   # 装 Docker + 建本地 context "docmind"
```

### 4. 源站 HTTPS（host nginx + Cloudflare）
- Cloudflare：把域名 A 记录指向服务器 IP（橙色云代理），SSL/TLS 模式设 **Full**，开启 **Always Use HTTPS**。
- 服务器 host nginx：加一个 `server_name docmind.cbsama.uk` 的 443 站点，自签名证书，反代到 `http://127.0.0.1:8080`（SSE 需 `proxy_buffering off; proxy_read_timeout 300s;`）。
- 子域名走 Cloudflare 的 `*.cbsama.uk` 通配符证书，无需额外签发。

---

## 二、部署 / 更新

改完代码后，本地执行：

```bash
./deploy.sh
```

它在远程构建镜像、滚动重启容器（用 `docker-compose.prod.yml` + `.env.prod`），并打印访问地址。**不需要登录服务器。**

- 换端口：`CLIENT_PORT=9000 ./deploy.sh`
- 临时直连暴露（不经 nginx，调试用）：`CLIENT_BIND=0.0.0.0 ./deploy.sh`
- 换 context 名：`DOCKER_CONTEXT=foo ./deploy.sh`

> 部署/重建容器时会有几秒的瞬时窗口，期间访问可能短暂 502，属正常，几秒后自恢复。

---

## 三、登录与权限（重要）

登录后每位用户默认只能发 **10 条消息**。两个开关都在 `users` 表上，**刻意没有任何写接口，只能直接改库**。

部署后，给某账号开通**管理员（可见评估模块）**和/或**无限调用**：

```bash
# 该用户需先在线上登录过一次（生成 users 行）
docker --context docmind compose -f docker-compose.prod.yml exec -T server \
  node -e "require('better-sqlite3')('data/memory.db').prepare(
    'UPDATE users SET is_admin=1, unlimited=1 WHERE username=?'
  ).run('你的GitHub用户名')"
```

- `is_admin=1` → 前端显示评估面板，`/api/eval/*` 放行（否则 403）
- `unlimited=1` → 不受 10 条限制

---

## 四、常用运维命令（都带 `--context`，无需 SSH）

```bash
docker --context docmind compose -f docker-compose.prod.yml ps          # 状态
docker --context docmind compose -f docker-compose.prod.yml logs -f server  # 日志
docker --context docmind compose -f docker-compose.prod.yml down         # 停止（保留数据卷）
docker --context docmind compose -f docker-compose.prod.yml up -d        # 启动
```

---

## 五、数据持久化

存在服务器的命名卷里，重新部署不丢：

| 卷 | 内容 |
|---|---|
| `server_data` | SQLite（用户 / 记忆 / 文档元数据 / 评估）`/app/data` |
| `uploads` | 上传的原始文件 `/app/uploads` |
| `chroma_data` | ChromaDB 向量库 |

---

## 六、密钥是怎么到服务器的

- `.env.prod` **只在本地**：被 `.dockerignore` 排除（不进镜像）、被 `.gitignore` 忽略（不进 git）。
- 部署时 compose 在**本地**读取 `.env.prod`，把 KEY=VALUE 通过 **SSH 加密通道**作为**容器环境变量**注入到远程运行的容器里。
- 服务器磁盘上**没有明文密钥文件**；但运行中的容器环境变量里有这些值（进程要用），有 root/docker 权限者用 `docker inspect` 可读到——这是必然的，属正常。

---

## 七、故障排查

- **`Docker context 'docmind' not found`** → 先跑 `./scripts/setup-remote.sh`。
- **`Missing packages/server/.env.prod`** → 见第一节第 1 步。
- **点登录 502 / `github_oauth_failed`** → 服务器连不上 github.com，或 OAuth 回调地址与 App 配置不一致（必须是 `${APP_URL}/api/auth/github/callback`）。
- **登录后立刻被登出 / 每次重启都要重登** → 没设 `COOKIE_SECRET`（用了每次随机的）。
- **页面 502 且持续** → 查容器：`... ps`（是否有崩溃/重启）、`... logs server`；查源站：服务器上 `curl http://127.0.0.1:8080/`。
- **`IP:8080` 公网能直连** → 说明 client 没绑 `127.0.0.1`（应为 `${CLIENT_BIND:-127.0.0.1}:...`），会绕过 Cloudflare，需修正。
