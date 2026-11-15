# infrlo VLESS+WS 节点

infrlo 只对外提供 HTTPS/TCP（固定端口 5000、子域名访问），不支持 UDP，
所以这里用 VLESS + WebSocket 方案：Node 启动脚本在首次运行时下载 Xray-core，
生成配置后以 VLESS+WS 入站监听 5000。

## infrlo 部署设置

- Build command: `npm install`
- Run command: `node index.js`
- 环境变量（在应用 Settings 里设置，不要写进仓库）：
  - `UUID`（必填）：节点的 UUID
  - `WS_PATH`（可选）：WebSocket 路径，默认 `/ws`
  - `ARGO_TOKEN`（可选）：Cloudflare Tunnel 的 token；设置后启动脚本会同时拉起
    cloudflared，节点可经隧道公共主机名访问（主机名需在 Cloudflare 后台指向
    `http://localhost:5000`）。infrlo 自带子域名的边缘证书不可用时走这条入口。

## 客户端连接

- 地址：`<应用名>.infrlo.com`，端口 443，传输 ws，TLS 开启
- 路径：与 `WS_PATH` 一致（默认 `/ws`），UUID 与环境变量一致
