# NetSpace 1.18.0 验证记录

本轮在 Windows 上验证已保存设备档案库。浏览器测试以虚构数据拦截 API，应用测试使用本机回环服务。没有扫描或连接真实局域网设备，也没有发起攻击。

| 检查 | 结果与覆盖 |
| --- | --- |
| `python -m unittest discover -s tests -q` | 131 项通过。 |
| `node tools/test_archive_search.cjs` | 17 项通过，覆盖模糊名称、文字地址片段、筛选交集及相同地址的独立记录。 |
| `node tools/test_device_check_report.cjs` 和 `node tools/test_device_check_tasks.cjs` | 报告 11 项、任务顺序 3 项通过。 |
| `node tools/ui_device_archive.cjs` | 档案回归先在旧界面失败，加入功能后通过。覆盖 50 条显示批次、网络隔离、迟到响应、重试、键盘焦点、320 px 布局、纯文本渲染与零写入请求。 |
| `node tools/ui_smoke.cjs` | 主流程、CSP、离线资源、导出、备份与窄屏布局通过。 |
| `node tools/ui_recovery.cjs` | 手动启动、断开网络时的虚构演示，以及另外四项恢复场景通过。 |
| `node tools/ui_upgrade.cjs` | 设备档案、历史、变化记录与跨窗口清理回归通过。 |
| `node tools/ui_device_check.cjs` | 服务检查与网页响应头的授权、结果隔离、报告导出、超时与窄屏回归通过。使用模拟 API。 |
| `build.ps1 -OutputDirectory artifacts/release-1.18.0` | 构建成功，生成 Windows x64 可执行文件、Windows ZIP 和源码 ZIP。 |
| `python tools/packaged_smoke.py --exe artifacts/release-1.18.0/NetSpace.exe --no-network --port 18766` | 本机启动、离线资源、单实例、任务保持空闲与正常退出均通过。 |

旧版服务检查测试在延迟响应仍待返回时尝试切换网卡，触发了界面已有的切换锁。更新后的测试先断言切换锁生效，再允许检查结束并验证换网后旧结果不可见。应用的服务检查和切换逻辑未作修改。

独立安全审查覆盖档案入口、只读接口、设备标识、文本渲染及迟到结果作废，未发现阻塞本轮发布的问题。界面打开档案或手动刷新时读取本机保存的数据。按网络切换、关闭窗口或本地数据清理后，先前的结果无法覆盖当前档案。设备字段不会解释为 HTML。

每批显示 50 条。当前版本仍会一次读取所选网络的全部档案并在浏览器建立索引。大量旧档案的服务端分页列在[后续功能方向](feature-directions-2026-11-20.md)中。

两张截图均由自动化测试使用虚构设备生成。[桌面界面](images/netspace-device-archive.png)展示名称、状态标签和详情，[320 px 界面](images/netspace-device-archive-320.png)展示纵向布局。
