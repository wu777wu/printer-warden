# 打印机管家（Printer Warden）

左侧栏的打印机管理插件：找到局域网里的共享打印机，把 Windows 打印队列绑到它、设为默认，并让它在打印机断电换 IP 后继续能打。

## 安装

本仓库是一个 DSH bundle（`package.json` 里的 `dsh.bundle.patch` + `dsh.client`）。装法二选一：

1. **让 Harness 安装本地目录**：在 DSH 里把本目录作为 bundle 安装（`install_bundle`），装完刷新页面，左侧栏出现打印机图标。
2. **手写 patch**：在 profile 的 `cordis.patch.yml` 里插入一行，`name` 指向克隆下来的绝对路径：

   ```yaml
   - insert:
       - id: printer-warden
         name: file:///C:/path/to/printer-warden
   ```

环境要求：Windows 10/11 + DSH Web GUI；打印机和本机在同一网段。

## 它解决什么

- 打印机 DHCP 地址变了，队列还指着老 IP → 打印任务卡住/报错。
- 每次换 IP 都要进「打印机属性 → 端口」手改。
- 「让 Windows 管理默认打印机」会把默认打印机换掉。

## 怎么用

1. 点左侧栏的打印机图标，打开「打印机管家」面板。
2. 面板会自动扫一次局域网；也可以随时点「扫描局域网」。
3. 看到打印机后点「绑定并设为默认」（或对着某一台点「绑定」）。
4. 以后打印机换 IP，面板会提示「打印机换了 IP」，点「修复」即可；端口本身已按名称固定，多数情况下不需要修。

## 原理

1. **发现**：并发扫本网段的 9100 / 631 / 515 / 80 端口；对 9100 发 `@PJL INFO ID` 拿型号，对 631 发 IPP `Get-Printer-Attributes` 拿 `printer-make-and-model`，再配合 mDNS 与 ARP 表识别设备。按型号里的型号数字（如 `1136`）与队列名匹配，所以 IP 变了也认得出是同一台。
2. **固定端口**：优先用打印机的 **DHCP 主机名 / PTR 名称**（实测形如 `HP<MAC地址>.`，由 MAC 派生、不会随 IP 变），写成标准 TCP/IP 端口的主机名。Windows 每次打印都会重新解析这个名字，路由器 DNS 会跟着 DHCP 更新，所以换 IP 不用改端口。
   - 单标签主机名在 Windows 里可能只走 NetBIOS，所以用**带尾点的绝对 FQDN** 写法。
   - 名字解析不出来时退化为 IP 端口，面板会提示可修复。
3. **队列**：`Add-PrinterPort` / `Set-Printer` 把现有队列指到新端口，`Win32_Printer.SetDefaultPrinter` 设为默认，并把 `LegacyDefaultPrinterMode=1`（HKCU）写死，避免 Windows 按「最近使用」改默认。
4. **权限**：先不提权直接做；只有系统拒绝时才弹一次 UAC（`启动 → RunAs`），结果写回 JSON。

## 面板/Host 接口

- `POST /printer-warden/api`，body `{ "action": "state" | "scan" | "bind" | "default", "ip": "..." }`；仅回环地址、同源 POST。
- Agent 工具 `printer_warden`，参数同上（`action` / `ip`）。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host：状态计算、扫描缓存、绑定、HTTP 路由、Agent 工具 |
| `lib/scan.js` | 发现：PJL / IPP / mDNS / ARP / 网段扫描 / 名称解析 |
| `lib/printers.js` | 队列与端口读取、默认打印机、绑定执行（先直跑、失败再 UAC） |
| `scripts/query.ps1` | 无 WMI 读打印队列 + 端口 + 默认打印机 |
| `scripts/apply.ps1` | 建/改端口、重指队列、设默认、写 LegacyDefaultPrinterMode |
| `scripts/launch-apply.ps1` | 需要时的 UAC 启动器 |
| `client.js` | 左侧栏图标 + 主面板 |

## 已知限制

- 依赖路由器 DNS 为 DHCP 客户端维护 A 记录（本机中国电信网关实测可以）。若某天路由器不再更新名称记录，面板仍能按型号找到打印机并「修复」成当前 IP。
- 端口名固定为 `PW_<型号>`；换一台不同型号的打印机会新建端口（旧端口保留，可手动删）。
- 不自动编译/下载到 PLC，也不改打印机自身网络配置。
