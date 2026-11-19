# NetSpace · 局域网视界

NetSpace 是一个面向 Windows 的本地局域网设备发现与 3D 拓扑可视化工具。它读取当前电脑连接的 Wi-Fi 或以太网接口，发现同一 IPv4 网段中可解析的设备，并用可旋转、可缩放的 3D 场景展示设备之间的推测关系。

> **项目定位**：网络观察与可视化工具。3D 坐标是模拟布局，连线是基于同网段关系的推断，不代表真实物理位置、交换机端口或设备拥有者。

## 界面截图

截图来自内置的“演示模式”，设备、地址和拓扑均为虚构数据，不包含真实局域网扫描结果。

![NetSpace 演示模式](docs/images/netspace-demo.png)

## 功能概览

- **本地网络发现**：读取 Windows 网卡、默认网关、邻居缓存，并对当前 IPv4 网段执行原生地址解析。
- **3D 拓扑视图**：支持拖动旋转、滚轮缩放、自动旋转、复位视角和节点选择。
- **设备档案**：为设备保存别名、备注、分组、已认识和忽略提醒状态。
- **历史与回放**：按网络保存扫描快照、变化记录和 3D 回放；历史内容与当前结果隔离。
- **变化提醒**：记录新增、再次发现、本次未发现和 IP 变化，可静音或按网络标记已读。
- **定时发现**：支持 1、5、10 分钟间隔；默认关闭，避免扫描重叠。
- **JSON 导出**：导出当前发现、历史快照或演示数据，并标记数据来源。
- **演示模式**：使用完全虚构的设备数据展示界面，不会把演示数据写入真实网络记录。
- **离线运行**：Three.js 和页面资源随源码提供，不依赖 CDN。

## Windows 快速开始

1. 从项目的 Releases 下载 `NetSpace-Windows-x64.zip`。
2. 解压后双击 `NetSpace.exe`。
3. 选择正在使用的 Wi-Fi 或以太网接口。
4. 点击“发现设备”，等待扫描完成。
5. 在设备列表、详情面板和 3D 视图中查看结果。

程序会自动打开本机浏览器页面，只监听 `127.0.0.1`，不会把管理页面暴露到局域网。应用关闭时请点击页面右下角的“停止服务/退出应用”按钮。

## 源码运行

需要 Windows、Python 3.8 或更高版本：

```powershell
python app.py
```

不自动打开浏览器时：

```powershell
python app.py --no-browser --port 8765
```

也可以双击项目根目录的 `start.bat`。默认页面地址为 `http://127.0.0.1:8765`；如果端口已被占用，程序会自动选择其他空闲端口。

## 数据和隐私

- 设备资料、扫描历史、变化记录和提醒设置保存在 `%LOCALAPPDATA%/NetSpace/netspace.db`。
- 数据只保存在本机，项目默认不上传扫描结果。
- 可以用 `--data-dir` 指定独立的数据目录，例如：

```powershell
NetSpace.exe --data-dir D:\NetSpaceData
```

- 设备名称、MAC 地址和解析结果可能来自 Windows 缓存；“已解析”不等于确认设备当前在线。
- Wi-Fi 客户端隔离、VLAN、设备休眠和网络策略会影响发现结果。
- 工具不进行端口扫描、不抓取通信内容，也不提供真实地理位置或真实空间定位。

## 发现范围说明

默认主动发现覆盖当前 IPv4 网段。对于大于 `/24` 的网段，为控制探测规模，主动探测会限制在本机所在 `/24`，同时合并当前接口所属完整网段内的有效系统缓存记录。界面会显示受限提示。

图中的连线表达“同一网段内的推测关系”，不表示已经确认的交换机端口连接。3D 位置只用于把节点分开显示，不表示距离或房间位置。

## 技术结构

```text
Windows 网卡 / 邻居缓存 / 原生地址解析
                │
                ▼
        windows_network.py
                │
                ▼
     app.py 本机 HTTP 服务与扫描状态
                │
       ┌────────┴────────┐
       ▼                 ▼
network_store.py   monitoring.py
 SQLite 历史与资料   定时发现与停止控制
       │                 │
       └────────┬────────┘
                ▼
          web/ 前端界面
   Three.js 3D 场景 + 本地资源
```

主要文件：

- `app.py`：本机服务、扫描流程、接口和应用生命周期。
- `windows_network.py`：Windows 网卡信息、邻居缓存和原生地址解析。
- `network_store.py`：SQLite 资料、历史快照和变化记录。
- `monitoring.py`：定时发现、间隔控制和停止逻辑。
- `web/`：中文界面、响应式布局和离线 3D 资源。
- `tests/`：网络边界、资料持久化、并发和接口回归测试。

## 测试与验证

运行 Python 测试：

```powershell
python -m unittest discover -s tests -v
```

当前版本已验证：

- Python 测试 78/78 通过。
- UI 冒烟、恢复和升级测试通过。
- Windows 打包程序可在没有 Python 的环境中启动。
- 真实 Windows 网络发现、跨重启资料保存、定时发现和正常退出通过。

详细记录见 [`docs/verification-1.1-2026-11-19.md`](docs/verification-1.1-2026-11-19.md)。

## Windows 打包

安装 PyInstaller 后执行：

```powershell
python -m pip install pyinstaller
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
```

构建结果包括：

- `dist/NetSpace.exe`
- `dist/NetSpace-Windows-x64.zip`
- `dist/NetSpace-Source.zip`

打包后的快速检查：

```powershell
python tools/packaged_smoke.py
```

## 版本记录

- **1.1.0**：加入 SQLite 资料与历史、3D 回放、变化提醒、定时发现、网络隔离、JSON 导出、移动端布局和完整 Windows 打包。
- **1.0.0**：保留在 `dist/releases/1.0.0/`，作为升级前版本存档。

## 后续方向

- 可选的 Windows 系统通知。
- 更精细的设备身份合并和 MAC 随机化处理。
- 可插拔的扫描适配器和更多网络类型。
- 远程只读查看模式（默认关闭，并需要显式访问控制）。
- 更丰富的拓扑过滤、标签和时间轴。

## 第三方组件

项目内置 Three.js 0.187.0 及 OrbitControls，许可证见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 和 `web/vendor/THREE-LICENSE.txt`。

当前仓库未附带额外开源许可证；如需将代码用于分发或商业项目，请先联系作者确认授权。
