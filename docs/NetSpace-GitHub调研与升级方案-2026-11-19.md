# NetSpace：GitHub 调研与升级方案

调研日期：2026-11-19。本文为升级建议，当前可执行程序与源码功能保持本次调研前的版本。

## 推荐方向

最值得优先做的是把“单次发现 + 3D 展示”扩展为“可长期使用的设备档案与变化记录”，随后补充设备名称和服务信息。现有 Windows 采集器、中文界面与离线 Three.js 视图可以继续使用。

推荐分为三类：

1. **日常使用版**：保存设备、起别名、定时发现、比较变化、提醒新发现的设备。最适合作为下一版。
2. **识别与展示增强版**：发现设备广播的名称、型号和服务；为 3D 图增加分组、固定布局和历史回放。
3. **网络管理版**：接入路由器与交换机数据，增加有依据的端口、AP 与设备连接关系。需要相应硬件支持和访问配置。

## 已核查的 GitHub 项目

| 项目 | 官方项目已提供的能力 | 对 NetSpace 的具体价值 | 集成条件与边界 |
| --- | --- | --- | --- |
| aceberg/WatchYourLAN [S1] | 持续发现、设备历史、新设备通知、数据库存储 | 参考它的设备生命周期与历史管理，增加首次/最后发现、扫描批次、变化记录 | 官方安装以 Linux 为主，扫描依赖 arp-scan；保留我们的 Windows 采集方式，参考功能和数据模型 |
| netalertx/NetAlertX [S2] | 持续监控、设备变化、通知、插件与多来源采集 | 设备别名与标签、分组、忽略规则、事件筛选、统一来源接口 | 官方部署文档明确不支持 Windows 主机；其数据源接入方式可以参考 |
| python-zeroconf/python-zeroconf [S3] | mDNS/DNS-SD 服务发现；服务名称、地址、主机名、端口和 TXT 属性 | 为部分打印机、NAS、电脑等补充设备声明名称、服务与服务端口 | 只覆盖实际发布相关服务的设备；选定网卡后应限制发现接口。当前主线要求 Python 3.11+ |
| StevenLooman/async_upnp_client [S4] | SSDP 搜索/监听及 UPnP 设备描述，包括名称、厂商、型号等 | 更容易看懂哪些节点可能是电视、音箱或路由器 | 仅覆盖支持并启用相应协议的设备；资料为设备声明。项目声明支持 Windows，当前主线要求 Python 3.11+ |
| vasturiano/3d-force-graph [S5] | 基于 Three.js 的 3D 力导向图、节点拖动/固定、分组配色、动态数据、相机聚焦与布局控制 | 借鉴设备分组、聚焦、固定位置与动态更新；结合我们自己的历史数据实现回放 | 这是图形组件，需要接入现有采集结果；历史回放由 NetSpace 增加。未必需要替换当前场景实现 |
| r0x0r/pywebview [S6] | 使用原生窗口显示 Web 界面，支持 Windows 与 Python/JavaScript 通信 | 将现有页面装进独立窗口，形成更完整的 Windows 应用体验 | Windows 的现代渲染方式依赖 WebView2；需要检测运行环境。托盘和桌面通知需另外实现 |
| librenms/librenms [S7] | 网络监控及基于 xDP、ARP 和接口资料的网络地图 | 为交换机、AP、网关和终端增加有来源的连接关系 | 需要硬件支持、只读管理访问与实际采集数据；仅连入普通 Wi-Fi 无法保证得到真实端口图 |

## 第一阶段：建议作为下一版的明确范围

这一步继续沿用现有发现方式，优先增加以下功能：

- **设备档案**：自定义名称、备注、图标、标签、分组，以及“已认识 / 待确认”标记。
- **本地保存**：使用 SQLite 保存网络、设备档案、扫描批次和事件，重启后仍能查看。
- **定时发现**：提供手动启动的持续监测开关，可选择 1/5/10 分钟；同一时刻只允许一个扫描任务，退出时停止。
- **变化比较**：显示新发现的设备、IP/MAC 变化、本轮未发现，以及首次/最后发现时间；不同网络分别记录。
- **新发现提醒**：先增加页面角标、事件列表和提示，后续再接 Windows 桌面通知；可忽略指定设备并限制重复提醒。
- **历史视图**：按时间查看扫描记录，选择一次历史结果在 3D 图中重现，明确显示“历史结果”。

现有 SendARP 可能使用系统缓存，因此这里应使用“首次发现 / 最后发现 / 本轮未发现”。只有获得额外响应证据时，才显示相应已响应状态；一次未发现不能直接作为设备离线的证明。

设备档案不能只用 IP 做永久编号：IP 会变化。建议结合网络标识与 MAC，MAC 缺失时保留临时记录；随机 MAC 和地址冲突要允许用户手工合并、拆分档案。

建议增加一个“设备 / 历史”切换入口；选中节点后，详情区显示别名、标签、首次发现、最后发现和最近变化。3D 节点位置应保持稳定，减少每次扫描后整体重新排列。

## 第二阶段：名称识别与 3D 增强

1. 增加 mDNS 与 SSDP 两个独立采集来源，和已有 ARP/邻居记录合并。每项资料保留来源与观察时间。
2. 详情区新增“设备声明名称、厂商、型号、发现的服务”。设备没有广播这些资料时保持未知。服务端口表示设备公开宣告的服务，不等同于完成了端口检查。
3. 3D 视图增加分组折叠、点击聚焦、节点位置固定，以及时间滑块；提供 2D 视图方便比较大量设备。
4. 保存用户调整过的模拟位置，回放历史时尽量沿用同一位置；连线继续标明来源。动画粒子只能表示相应事件或展示效果，不能当作真实流量数据。
5. 更新打包用的 Python 至上述库支持的版本；运行时随 exe 分发，用户仍无需单独安装 Python。

独立 Windows 窗口可以作为这一阶段的单独可选项：使用 pywebview 显示当前页面，明确选择兼容现代模块与 WebGL 的 Windows 渲染方式，检测 WebView2，并保持本机服务的访问保护。

## 采集能力的进一步改进

除 GitHub 项目外，还核查了 Windows 官方网络接口文档 [S9]：

- **增加主动响应验证**：评估 ResolveIpNetEntry2。文档说明它会清除匹配的旧邻居项后，再发出 IPv4 ARP 或 IPv6 邻居请求；可为“本次有响应”提供更直接的证据。应在真实 Windows 环境验证权限、耗时、取消及系统邻居表影响，成功时显示响应依据，失败时保留未知状态。
- **增加 IPv6 设备来源**：合并 Windows IPv6 邻居记录、协议广播与已知地址验证。IPv6 网段不能沿用当前 IPv4 /24 的逐地址枚举方式。

这些适合在基础历史记录完成后单独实现和验证，避免将资料缓存与本次响应混用。

## 第三阶段：有数据依据的拓扑与深入检查

可以参考 LibreNMS，将路由器、交换机或 AP 的只读接口作为额外数据源，采集 LLDP/CDP 邻居、接口和端口信息。每条关系分别标记为“设备上报、邻居协议发现、ARP 推断、用户手动指定”等，保留来源与时间。

设备支持什么，就显示对应信息：普通家用设备不一定公开这些接口，受隔离的 VLAN 或 Wi-Fi 客户端也不会因为增加 3D 界面而变得可见。逐设备流量需要路由器、AP 或其他观测点提供相应计数；本机网卡总流量不足以代表所有设备的流量。

Nmap [S8] 可作为后续“深入检查”方向，先考虑读取用户已有的 XML 结果，再单独评估外部工具调用。它会增加扫描、驱动与分发许可方面的工作，建议放在基础监测功能之后评估。

## 下一版验收标准

- 重启后保留设备别名和历史；切换网络时不会串用其他网络的设备档案。
- 定时任务不重叠，退出后不继续启动新任务。
- 演示数据、历史结果和当前真实结果分别标明来源，不能相互污染。
- 缓存记录不被自动提升为“确认在线”，未发现事件不直接被写成“确定离线”。
- 提醒可静音、忽略与去重；同一条记录不会每轮扫描重复提醒。
- 大量节点时仍可搜索、聚焦与查看详情；缺少三维渲染支持时保留列表和导出。
- 新采集来源在真实 Windows 网卡上验证，包括切换 Wi-Fi/网线与网卡断开后的恢复。

## 依赖与分发记录

官方项目所列许可：WatchYourLAN 为 MIT；NetAlertX 为 GPL-3.0；python-zeroconf 为 LGPL-2.1-or-later；async_upnp_client 为 Apache-2.0；3d-force-graph 为 MIT；pywebview 为 BSD-3-Clause；LibreNMS 为 GPL-3.0。Nmap 使用 NPSL。实际引入依赖或复制代码时，应按所选版本核对许可与分发要求。

当前方案的首轮功能可以按现有项目独立实现。后续引入第三方库时，应固定版本、随包保留所需声明，继续使用本地页面资源，并明确新增的系统运行时需求。

## 官方来源

- [S1] WatchYourLAN README / 配置：`https://github.com/aceberg/WatchYourLAN`
- [S2] NetAlertX 官方主库：`https://github.com/netalertx/NetAlertX`；部署文档：`https://docs.netalertx.com/installation/`
- [S3] python-zeroconf README、browser 示例与 pyproject.toml：`https://github.com/python-zeroconf/python-zeroconf`
- [S4] async_upnp_client README 与 pyproject.toml：`https://github.com/StevenLooman/async_upnp_client`
- [S5] 3d-force-graph README：`https://github.com/vasturiano/3d-force-graph`
- [S6] pywebview 主库：`https://github.com/r0x0r/pywebview`；Windows 安装与运行时文档：`https://github.com/r0x0r/pywebview/blob/master/docs/guide/installation.md`
- [S7] LibreNMS 主库：`https://github.com/librenms/librenms`；Network Map 文档：`https://docs.librenms.org/Extensions/Network-Map/`
- [S8] Nmap 主库：`https://github.com/nmap/nmap`；Windows 文档：`https://nmap.org/book/inst-windows.html`；许可说明：`https://nmap.org/book/man-legal.html`
- [S9] Windows SendARP 文档：`https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-sendarp`；ResolveIpNetEntry2 文档：`https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-resolveipnetentry2`

以上为官方仓库与文档的功能核查，并非在本机安装和运行了这些第三方项目。
