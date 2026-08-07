# RedFoxHub 与 TikHub：价格与服务一手资料核查

访问日期：2026-08-07

## 范围与证据规则

本笔记只使用 `redfox.hk`、`tikhub.io` 及其官方子域名的公开页面和官方文档。没有使用第三方测评、汇率或推测性流量数据。价格按网站原币种记录，不做人民币与美元换算。

以下状态用于区分证据强度：

- **可直接核实**：公开页面或官方文档明确写出。
- **需登录确认**：公开说明指向控制台、支付页或账户，但未公开完整值。
- **官网未披露**：本次检查的公开价格页、API 目录、帮助/法律页未找到。
- **推断**：根据已核实事实得出的选择建议，不视为供应商承诺。

## 先给结论

若重点是更广的平台覆盖、低门槛按次计费、明确的并发扩容方案和更完整的公开法律/退款规则，**TikHub 的公开证据更强，通常更适合通用社交数据产品、AI 代理和跨平台数据团队**。其代价是退款政策严格，而且官方条款明确说明 99.9% 只是产品页主张，不构成保证的 SLA。

若重点是人民币充值、中国新媒体平台和内容运营 Skills，**RedFoxHub 更贴近中国内容运营与本地结算场景**。它广告的免费试用为 200 积分；TikHub 则是 $0.05、约 50 次。两者单位不同，不能仅凭免费数字直接比较。RedFoxHub 对阶梯统计周期的公开说明不一致，数字速率上限、未消耗余额退款规则和非企业 SLA 也不够完整。

因此，不存在脱离场景的单一赢家：通用 API 能力与公开透明度选 TikHub；中国内容运营工作流与人民币结算优先评估 RedFoxHub。企业采购不能只看首页可用性数字，必须取得书面 SLA、退款/服务抵扣、数据处理条款和实际端点报价。

## 关键对比

| 维度 | RedFoxHub | TikHub | 初步判断 |
| --- | --- | --- | --- |
| 产品定位 | 新媒体数据接口、智能分析 Skills、图片/视频等工具 API。[首页/登录页](https://redfox.hk/login)、[Skills 示例](https://redfox.hk/skills/no/wsfKum2X)、[工具 API 示例](https://redfox.hk/apis/tool/7OM96HCF) | 面向开发者、研究者和 AI 公司的社交媒体数据基础设施，包括实时 REST API、数据集和 MCP 工具。[About](https://tikhub.io/about)、[首页](https://tikhub.io/) | TikHub 更偏基础设施；RedFoxHub 更偏中国新媒体数据与现成工作流。此句为推断。 |
| 公布的 API 覆盖 | 官方平台 JSON 将抖音、小红书、公众号、视频号、哔哩哔哩、今日头条、AI 搜索、TikTok 标为 `online`，将快手、X、YouTube、Instagram 标为 `online_new`；微博、百家号、百度、知乎标为 `coming_soon`。[平台 JSON](https://redfox.hk/story/web/api/doc/platforms)、[API 目录](https://redfox.hk/apis) | 宣称 16 个平台、1,000+ REST 端点和 990+ MCP 工具；公开目录列出 TikTok、抖音、Rednote、Instagram、X、YouTube、Threads、LinkedIn、Reddit、Bilibili、微博、Lemon8、快手、微信、知乎等。[API Reference](https://tikhub.io/api-reference)、[About](https://tikhub.io/about) | TikHub 的公开目录更广；RedFoxHub 企业页另称 30+ 平台、3,000+ API，但当前可见目录未逐项证明该营销数字。[企业页](https://redfox.hk/enterprise) |
| 标准按次价格 | 优质数据基价 ¥0.04/次，实时数据基价 ¥0.06/次；30,000 次及以上分别降至 ¥0.02、¥0.03。部分接口另行定价，工具端点可高于该区间。[价格页](https://redfox.hk/pricing)、[工具 API 示例](https://redfox.hk/apis/tool/7OM96HCF) | 按端点 $0.001–$0.01/次；公开平台页显示 Instagram $0.002/次、Rednote $0.01/次等差异。[价格页](https://tikhub.io/pricing)、[Instagram API](https://tikhub.io/instagram-api)、[Rednote API](https://tikhub.io/xiaohongshu-api) | 因币种不同，不做直接价格胜负。TikHub 对端点差价与试算的公开说明更完整。 |
| 阶梯规则 | 价格表和 FAQ 说账户下所有接口的**累计调用量**合并判档，但同页成本估算器又说按**每日总请求量**计算；统计周期存在冲突。跨档后的新调用按新档单价，最低 5 折。[价格页](https://redfox.hk/pricing) | 账户每日总请求量分段累进计费：0–1,000 无折扣，随后 10% 至 50%；每日重新按总量计算。[价格页](https://tikhub.io/pricing)、[价格计算 API](https://docs.tikhub.io/186826052e0) | TikHub 的规则可直接预测；RedFoxHub 必须先书面确认统计周期和判档单位。 |
| 额度与充值 | 1 元兑换 10 积分；最低 100 元起充，对应 1,000 积分；支付页和后台配置为最终值。[价格页](https://redfox.hk/pricing) | PayPal、支付宝、USDT；支付宝公开说明每日充值上限 $250。企业银行转账需先建立 2–4 周关系并由 TikHub 决定资格。[Getting Started](https://tikhub.io/getting-started)、[价格页](https://tikhub.io/pricing) | RedFoxHub 对人民币积分换算更清楚；TikHub 支付方式更多。TikHub 最低充值额官网未披露。 |
| 免费试用 | 注册送 200 积分，价格页未公开这些积分适用的具体端点清单。[登录页](https://redfox.hk/login)、[价格页](https://redfox.hk/pricing) | 新账户一次性 $0.05，约 50 次，无需信用卡；部分端点必须使用付费余额。官网另有“测试每个端点”的表述，与“部分端点不接受免费额度”存在口径冲突。[Getting Started](https://tikhub.io/getting-started)、[价格页](https://tikhub.io/pricing) | 两者都可免预付试用；端点适用范围应在注册后逐项确认。 |
| 调用限制 | API 文档公开 `4004` 频率限制错误，但未给出数字 RPS、按账户还是按端点，也未公开自助扩容价格。[抖音 API 文档](https://redfox.hk/apis/douyin/0OT1E306) | 默认每个 API 路径 10 RPS；不同路径可并行。RPS 计划从 20 RPS/$5 月到 100 RPS/$55 月，企业可定制超过 100 RPS。[价格页](https://tikhub.io/pricing)、[TikTok API](https://tikhub.io/tiktok-api) | 对并发规划，TikHub 明显更可核实。 |
| 失败与超额 | 价格页称非 200 失败请求不计费；余额不足返回 `3201`，需充值后继续，未公开自动负余额超额。[价格页](https://redfox.hk/pricing)、[抖音 API 文档](https://redfox.hk/apis/douyin/0OT1E306) | 非 200 请求不计费；余额不足返回 402。相同参数重复调用会重新取实时数据并再次计费；成功响应的 `cache_url` 可免费访问 24 小时。[价格页](https://tikhub.io/pricing)、[官方文档](https://docs.tikhub.io/) | 两家均公开失败不计费和余额不足即停；TikHub 对重复请求和缓存说明更完整。 |
| 企业服务 | 单次充值 ¥30,000 或累计消费 ¥50,000 解锁企业权益；含 5%–10% 充值赠送、1 对 1 支持、定制接口、对公结算和合同 SLA。[企业页](https://redfox.hk/enterprise)、[价格页](https://redfox.hk/pricing) | $3,000 单次充值或 $4,500 累计消费可进入企业层；公开权益含永久 5% 支付手续费减免、3%–10% 充值赠额、免费优先定制端点、1 对 1 支持和私有部署。[企业页](https://tikhub.io/enterprise)、[价格页](https://tikhub.io/pricing) | 两家都公开企业门槛；币种和权益结构不同，需按实际合同比较。 |
| 支持 | 免费版社区支持，按量版工单优先，企业版专属群/对接人；未公开响应时间。[价格页](https://redfox.hk/pricing) | Discord 标称 10–30 分钟、邮件 1–12 小时、GitHub 1–2 天；企业有工程师直连。以上是官网目标，不是 SLA。[联系页](https://tikhub.io/contact)、[企业页](https://tikhub.io/enterprise) | TikHub 的公开响应预期更明确。 |
| 退款 | 服务条款称，除法律强制规定或平台系统故障造成重复扣费外，已消耗积分和已履行企业服务费用不退；未消耗付费积分的退款条件未写清。[服务条款](https://redfox.hk/terms) | 所有购买原则上不可退款；只有特定端点/功能不可用且经 TikHub 技术团队确认时才可能退款。退款原路退回；企业合同另有约定时以合同为准。[退款政策](https://user.tikhub.io/refund)、[使用条款](https://user.tikhub.io/terms) | 两家政策都偏严格；TikHub 的独立退款页更清楚。RedFoxHub 未消耗余额应在充值前书面确认。 |
| 可靠性承诺 | 登录页宣传 99.99% 可用性；价格页只承诺企业版可协商 SLA，没有公开测量口径、服务抵扣或标准条款。[登录页](https://redfox.hk/login)、[价格页](https://redfox.hk/pricing) | 多个产品页展示 99.9% uptime；但使用条款明确不保证任何特定 uptime、availability 或 performance，服务也不面向容错或关键任务应用。[TikTok API](https://tikhub.io/tiktok-api)、[使用条款](https://user.tikhub.io/terms) | 两者的首页数字都不能当作合同 SLA。RedFoxHub 至少公开表示企业可签 SLA，但具体值需合同确认。 |
| 合规与信任声明 | 隐私政策声明遵守中国《个人信息保护法》《网络安全法》《数据安全法》，原则上境内存储，并列出 TLS、最小权限、密钥脱敏、入侵检测和定期安全审计等措施；未公开 ISO 27001、SOC 2、等保级别或审计报告。[隐私政策](https://redfox.hk/privacy) | 声称只处理公开数据并与 GDPR/CCPA 对齐；条款说明用户负责合法使用、存储和处理数据，也说明第三方平台变化可能影响服务。[About](https://tikhub.io/about)、[使用条款](https://user.tikhub.io/terms)、[隐私政策](https://user.tikhub.io/privacy) | 两家都有合规自述，但都不能替代第三方审计或采购尽调。TikHub 的数据责任边界写得更细。 |

## 价格细节

### RedFoxHub

**可直接核实**：

- 标准优质数据六档单价为 ¥0.04、¥0.036、¥0.032、¥0.028、¥0.024、¥0.02/次；标准实时数据对应 ¥0.06、¥0.054、¥0.048、¥0.042、¥0.036、¥0.03/次。档位阈值为累计 0、1,000、5,000、10,000、20,000、30,000 次。[价格页](https://redfox.hk/pricing)
- 多接口调用合并计算累计量，跨档后只有新调用使用新价。页面还明确说部分端点不按标准表计价；例如 Seedream 提交任务公开标为最低 ¥0.36/次，image2-GPT 提交任务最低 ¥0.5/次。[价格页](https://redfox.hk/pricing)、[Seedream API](https://redfox.hk/apis/tool/7OM96HCF)、[image2-GPT API](https://redfox.hk/apis/tool/HUV4KRFQ)
- 免费、按量和企业使用同一鉴权体系；API Key 可放在 `REDFOX_API_KEY` 或 `X-API-KEY` 请求头。[API 文档](https://redfox.hk/apis)
- 价格页称非 200 失败请求不计费；积分不足返回 `3201`，不会自动继续超额调用。[价格页](https://redfox.hk/pricing)、[API 文档](https://redfox.hk/apis)
- 价格口径存在需确认之处：价格表和 FAQ 写账户下所有接口合并累计，同页成本估算器写“按每日总请求量计算”，部分具体 API 页和服务条款又使用“按接口累计”表述。正式采购应要求书面确认统计周期、判档单位和跨档算法。[价格页](https://redfox.hk/pricing)、[服务条款](https://redfox.hk/terms)

**需登录确认**：每个端点的实时扣费、试用积分适用范围、支付方式、支付手续费、余额有效期、发票规则、控制台实际充值档位和动态限速值。登录后充值页显示支付宝、微信支付和企业支付，但本笔记不把登录后界面值当作长期公开承诺。

**官网未披露或未写清**：未消耗积分退款、余额提现/转让、统一数字 RPS 上限、并发扩容价格，以及企业 SLA 的计算口径和赔付。

### TikHub

**可直接核实**：

- 基础端点价为 $0.001–$0.01/次。折扣按账户每日总量分段累进，而不是达到某档后把当日全部请求统一重算。30,000 次以上的该分段为基础价 5 折。[价格页](https://tikhub.io/pricing)、[价格计算 API](https://docs.tikhub.io/186826052e0)
- 阶梯折扣和 RPS 订阅互相独立。默认 10 RPS 是“每个 API 路径”的限制。[价格页](https://tikhub.io/pricing)
- Rednote 公开页称 $0.01/次且一般不参加折扣，除非超过每月 100 万次；抖音 Search 系列也称 $0.01/次且不参加普通量阶折扣。这说明总价表不能替代逐端点核价。[Rednote API](https://tikhub.io/xiaohongshu-api)、[Douyin API](https://tikhub.io/douyin-api)
- 数据集另行计价，官网公开的量价最低可到每 1,000 条 $0.40；数据集订单需先全额支付。[价格页](https://tikhub.io/pricing)

**需登录确认**：完整端点市场的当前单价、哪些端点接受免费余额、各 RPS 中间档详情、最低充值额、余额有效期、支付页手续费和最终企业赠额。

**官网未披露**：社交数据 API 的合同式标准 SLA、服务抵扣表和对所有端点统一适用的延迟承诺。官方文档虽然链接状态监控页，但本次没有取得可用于长期可用性核验的历史数据。

## 接入与服务差异

RedFoxHub 的公开文档提供 REST 路径、参数表、响应字段、状态码以及 Shell、JavaScript、Java、Python 等示例。其优势是中文内容平台数据和可直接安装的 Skills；工具目录还包含图片/视频生成相关端点。接口示例统一用 API Key 请求头。[API 目录](https://redfox.hk/apis)、[小红书 API 示例](https://redfox.hk/apis/xiaohongshu/KR1LPTBF)

TikHub 的接入流程是注册并验证邮箱、在控制台检查端点价格、充值、使用 Bearer Token 调用 REST API。它提供完整 API Reference、教程、官方 Python SDK 和 MCP 集成。部分 creator 级端点仍要求用户提供平台 Cookie，这不能与“所有公开数据都不需要 OAuth/平台账号”混为一谈。[Getting Started](https://tikhub.io/getting-started)、[API Reference](https://tikhub.io/api-reference)

## 采购前必须补问

1. 让两家用同一组目标端点和月调用曲线出书面报价，不以首页最低价替代实际端点价。
2. 要求明确成功、超时、4xx、5xx、重试和异步任务失败分别如何扣费。
3. 要求提供 RPS、并发、每日/月配额、突发限制和提额交付时间。
4. 若是生产关键链路，要求书面 SLA：测量窗口、排除项、维护通知、服务抵扣、终止权和数据恢复。
5. 要求确认充值余额有效期、退款、拒付、发票/税、支付手续费和企业赠额锁定条件。
6. 若处理个人数据或跨境数据，要求 DPA、子处理者清单、数据驻留、删除时限和安全事件通知条款。

## 简短初步结论

- **价格与服务透明度：TikHub 较好。** 它公开了端点价格区间、每日累进折扣、失败不计费、每路径 RPS、提速价格范围、企业门槛和退款政策。
- **中国内容运营适配：RedFoxHub 较好。** 它提供人民币积分、抖音/小红书/公众号数据、Skills 和中文运营工具；但阶梯折扣的统计周期需先书面确认。
- **平台与 API 广度：TikHub 较好。** 其可逐项查看的公开目录覆盖 16 个平台和 1,000+ REST 端点。RedFoxHub 企业页虽称 30+ 平台和 3,000+ API，但当前公开平台 JSON 只把 12 个平台列为 `online` 或 `online_new`。
- **可靠性：没有可直接判定的赢家。** RedFoxHub 的 99.99% 和 TikHub 的 99.9% 都缺少公开测量与赔付细则；TikHub 条款还明确否定 uptime 保证。企业场景应以最终合同为准。
- **最终建议：** 默认优先试用 TikHub；若核心需求集中在中国新媒体、人民币结算或 RedFoxHub 独有 Skills，再用 3–5 个真实端点做并行试跑。比较成功率、P95 延迟、有效每条数据成本和支持响应后再签约。
