# Mega + ScorpioFS 本地部署

该 Compose 提供面向 ScorpioFS 的最小 headless Mega 栈：PostgreSQL、Redis、RustFS、bucket 初始化、Mega HTTP API 与 ScorpioFS。它不会启动 Mega UI、Orion、Campsite 或 MySQL。

> 仅用于本地开发与演示。示例包含测试凭据，ScorpioFS HTTP API 没有认证；不要直接用于生产或暴露到公网。

## 前置要求

- Git 2.30+；
- Docker Engine 与 Docker Compose 2.20+；
- Linux/FUSE 主机，存在 `/dev/fuse` 且允许向容器授予 `CAP_SYS_ADMIN`；
- 建议至少 4 CPU、8 GB RAM 和 10 GB 可用磁盘。

Mega 可以单独运行在 Docker Desktop；ScorpioFS 的 FUSE 挂载依赖 Linux 内核能力，在 Windows、macOS、rootless Docker 或部分托管环境中通常不可用。先在实际运行主机确认：

```bash
test -c /dev/fuse
```

ScorpioFS 的 FUSE mount 默认只存在于容器的 mount namespace。通过其 HTTP API 操作不需要额外设置；若宿主机或其他容器必须直接读取挂载目录，还需要单独配置 `rshared` bind mount 和 mount propagation。

## CI 中的两级容器验证

普通 Pull Request 在 GitHub 托管的 `ubuntu-24.04` runner 上执行无 FUSE 的核心检查：核对固定 submodule、构建 ScorpioFS 镜像，并仅以 `docker compose ... up --no-build mega` 启动 Mega 及其依赖。CI 会用审查过的 OCI manifest digest 覆盖 Compose 和 ScorpioFS Dockerfile 中的可变标签，避免同一次提交因标签移动而改变验证镜像；Debian 软件源与 crates.io 解析仍属于后续需要继续收紧的外部输入。

真实 mount/read/write 验证只能手工触发 `.github/workflows/fuse-smoke.yml`，并需要：

- Linux x86-64 主机存在 `/dev/fuse`，Docker 可映射该设备并授予 `SYS_ADMIN`；
- runner 标签同时包含 `self-hosted`、`linux`、`x64`、`fuse`、`ephemeral`；
- runner 采用一次性 JIT 或 `config.sh --ephemeral` 注册，job 结束后销毁整台运行环境；
- GitHub `trusted-fuse` Environment 只允许默认分支，并配置独立 required reviewer；
- runner 不保存仓库 secret，且不与生产工作负载共用 Docker daemon。

触发工作流时，`mount_path` 必须是当前 Mega 数据中存在的 monorepo 路径。工作流会等待 `/antares/mounts/{id}/ready`，在 ScorpioFS 容器内确认真实 FUSE mount，写入、读取并删除探针文件，随后卸载并删除本次 Compose volumes。

## 安装

新克隆仓库时一并拉取固定的上游提交：

```bash
git clone --recurse-submodules https://github.com/marshawcoco/gitmono-agent-team.git
cd gitmono-agent-team
```

已有克隆在仓库根目录执行：

```bash
git submodule update --init --recursive --depth 1
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

PowerShell 复制环境文件：

```powershell
Copy-Item deploy/.env.example deploy/.env
```

修改 PostgreSQL 凭据时，还必须同步修改 `MEGA_DATABASE_URL`。该变量作为完整连接 URL 传给 Mega；用户名或密码中的 `/`、`?`、`#`、`%`、`@` 等保留字符必须进行百分号编码。例如，密码 `change@me` 应在 URL 中写成 `change%40me`：

```dotenv
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change@me
POSTGRES_DB=mono
MEGA_DATABASE_URL=postgres://postgres:change%40me@postgres:5432/mono
```

首次启动会拉取按 OCI digest 固定的 Mega 镜像，并从 `submodules/scorpiofs` 的固定提交构建 ScorpioFS，通常需要数分钟。Windows Git 可能把子模块脚本检出为 CRLF；自定义 ScorpioFS Dockerfile 和 bucket 初始化命令会在容器内将所需入口脚本规范化为 LF。

默认 Mega 镜像便于快速安装，但本仓库无法从其公开元数据证明该 digest 与 `submodules/mega` 的 gitlink 一一对应。需要严格源码对齐时，先从固定 submodule 构建本地镜像，再修改 `deploy/.env`：

```bash
docker build \
  -f submodules/mega/mono/Dockerfile \
  -t gitmono/mega:source \
  submodules/mega

# deploy/.env
MEGA_ENGINE_IMAGE=gitmono/mega:source
```

Mega 源码构建明显慢于拉取预构建镜像，并需要更多磁盘空间。Compose 已覆盖其默认启动脚本，直接以 HTTP-only 模式运行构建出的 `/usr/local/bin/mono`。

ScorpioFS 上游示例仍使用 `/lfs`，但当前锁定的 Mega 提供通用 `/api/v1/lfs` 路由，因此本仓库将 `SCORPIO_LFS_URL` 设为 `http://mega:8000/api/v1/lfs`。当前 ScorpioFS 尚未消费该配置值，但入口脚本要求它存在；保留真实路由可避免后续启用 LFS 时指向无效端点。

## 验证

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
curl --fail http://127.0.0.1:8000/api/v1/status
curl --fail http://127.0.0.1:2725/health
docker compose --env-file deploy/.env -f deploy/compose.yaml run \
  --rm --no-deps --no-TTY scorpiofs doctor
```

`doctor` 使用一次性 sibling container，继承 ScorpioFS service 的镜像、配置、网络和 named volume，但不进入长期 service container 已被私有 FUSE 子挂载覆盖的 mount namespace。这样能可靠验证底层 workspace 可写性；真实 FUSE 数据通路仍由 mount readiness、mountinfo 以及写入、精确读取、删除探针单独验证。

ScorpioFS 的 `/health` 是轻量存活检查，不验证 Mega 或具体 FUSE mount。创建 Antares mount 后，应另外检查 `GET /antares/mounts/{id}/ready`。

默认只发布两个 loopback 端点：

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| Mega API | `http://127.0.0.1:8000` | Monorepo/Git HTTP API |
| ScorpioFS API | `http://127.0.0.1:2725` | 未认证，仅绑定 loopback |

PostgreSQL、Redis 与 RustFS 只在 Compose 内部网络可见。ScorpioFS 数据保存在 `scorpio-data` volume；Mega、数据库、缓存和对象数据也各自使用 named volume。

## 日常操作

```bash
# 查看日志
docker compose --env-file deploy/.env -f deploy/compose.yaml logs -f mega scorpiofs

# 停止并保留数据
docker compose --env-file deploy/.env -f deploy/compose.yaml down

# 再次构建当前固定提交
docker compose --env-file deploy/.env -f deploy/compose.yaml build --pull scorpiofs
```

删除全部 volumes 会永久移除本地数据库、对象和 ScorpioFS 缓存；只有确认不再需要数据时才执行 `docker compose ... down -v`。

上游升级应显式选择并审查 commit，再更新 gitlink；不要在部署主机上无审查地执行 `git submodule update --remote`：

```bash
git -C submodules/scorpiofs fetch origin main
git -C submodules/scorpiofs checkout <reviewed-commit>
git add submodules/scorpiofs
```

## 上游来源

- [Mega Docker deployment](https://github.com/gitmono-dev/mega/tree/main/docker)
- [ScorpioFS container deployment](https://github.com/gitmono-dev/scorpiofs/tree/main/deploy)
- [Libra](https://github.com/libra-tools/libra)
