# 数字展品使用授权核验应用

供小型展馆在选取数字展品组成展览包时，沿**全部来源链**逐节点核验使用授权（媒介、地区、有效期、撤销状态），并在发布时**原子保存不可变的核验快照与素材清单**。授权随后变更时自动重算资格，仅把“由合格变不合格”的已发布包标记为**需复核**，原快照始终保留。

策展人还可为待发布包编排**多站巡展**：每站单独填写名称、展示媒介、地区及起止日期，按顺序展出（站间不得重叠，首尾日期均算占用），整包共享同一份入展素材清单。核验**逐站沿全部来源链**检查每个节点有一份未撤销授权独自覆盖该站整段展期——不同站可用不同授权，**同站不可拼接短授权**；发布在同一事务内重读行程、清单与授权依据，任一站失败则整包不发布。既有单站包的请求/响应完全兼容，旧包一律视为单站。

策展人还可对待发布 / 需复核包录入若干**拟取得的授权报价**（每项注明素材、媒介、地区、有效期与非负整数成本），系统做**只读的报价组合预览**：基于同一份当前授权与来源关系，求**总成本最低**的报价组合，使每站每个入展素材及其全部来源节点均由一份现有有效授权或一份所选报价**独自覆盖整段展期**。共享节点（含跨站）只核算一次、一份报价可覆盖多站、同站短授权/短报价不得拼接；总成本并列时先取报价数少者，再按输入序号序列取字典序最小。无解时按站列出仍缺授权的节点、现有授权与各报价的失格原因及全部来源路径。预览不写入授权、包、状态或快照，依据版本不变，**已发布包不可预览**。

成功发布时，系统在**与发布快照同一个事务**内封存一份**可导出的签名发布凭证（attestation）**：当时的素材清单、完整来源子图、逐站行程、每个站×节点**实际采用的未撤销授权条款全文**与全部来源路径，以及核验规则版本与规则参数，并用**本机持久化 Ed25519 密钥**签名。审计人员**脱离馆内数据库**时，仅凭凭证文件与签发方公开密钥，运行随附的**零依赖独立校验程序**即可复算签名、来源链与**逐站整段覆盖**，得到逐站结论与逐项篡改原因。凭证完全自包含：授权事后修改、撤销或删除**不改变旧凭证**，已发布包转为需复核也不影响旧凭证。**密钥轮换自动保留旧公钥**；升级前的旧发布快照可申请补发，但补发只读取快照自身，**旧快照若缺少证明所需字段则明确拒绝（`422 UNSUPPORTED_SNAPSHOT`），绝不用当前授权拼凑**。

策展人还可为**待发布**包编排**替代素材方案**：为包中至多 6 件入展素材分别指定 1～8 件**现有**替代素材（未指定的素材保持不变；重复编号、非包内原素材或候选不存在均**整次拒绝**）。预览对“每件原素材及其候选中**恰选一件**”的全部组合，按**替换后的去重清单**（沿原清单顺序首次出现去重）重算完整来源链与单站/多站逐站授权资格，仅**全站合格**的方案可选，并按 **替换件数最少 → 最终清单升序 → 原清单顺序的选中编号**（原素材=0，候选按提交顺序 1～8）依次打破并列。预览**只读**，返回替换明细、逐站核验结果、依据版本、原清单与行程指纹；无解时返回**当前清单**的逐站缺口、不修改包。确认在**同一事务**内核对包仍为待发布、依据版本与清单/行程指纹未变，由服务端按同一输入**重算最优方案并再次整站核验**后原子应用；过期、输入不符或重算失格均拒绝且**不部分修改**。既有核验、发布、复制与已发布包冻结规则完全兼容。

策展人还可选取 **2～20 个待发布展览包组成联展批次**：预览**按包**展示单站或多站**逐站核验结果**、**共同依据版本**及各包**清单指纹与行程指纹**；只要有一个包失格（或不存在/非待发布），就**按包列出缺口且不发放确认凭据、禁止确认**，预览**不写入任何数据**（无快照、无凭证、依据版本与包状态不变）。确认时**携带预览凭据**，服务端在**同一事务**内核对**包集合、各包待发布状态、共同依据版本与各包双指纹**，并按**当前授权及来源关系重算全部包**；全部合格时，先为每包封存与单包发布同构的**不可变发布快照与签名凭证**（`sealContext:"publish-batch"`，可被既有凭证导出与离线校验程序直接消费），再把整批**一起转为已发布**。包不存在、凭据不符、状态或依据变化、任一包重算失格时**整批拒绝**：不产生任何快照、凭证或部分发布（批次闸门失败不留痕；既有**单包发布**及其 **422 失败留痕**、凭证导出/补发/离线校验**完全兼容**）。页面与可调用的 HTTP API 均可完成该流程。

- 后端：Node.js 20 + Express + better-sqlite3（SQLite，同步事务）
- 前端：原生 HTML/CSS/JS，无构建步骤
- 交付：Dockerfile + docker-compose 一键启动，数据库自动初始化

---

## 一、一键启动（Docker Compose，推荐）

前置：已安装 Docker 与 Docker Compose 插件。

```bash
docker compose up --build -d
```

启动后打开浏览器：

- **Web 地址：http://localhost:3000**

首次启动会自动建表并写入一份演示数据（由 `SEED_DEMO=1` 控制；数据库非空时自动跳过）。
停止 / 查看日志：

```bash
docker compose logs -f
docker compose down            # 停止（数据保留在命名卷 exhibit-data 中）
docker compose down -v         # 停止并删除数据库卷（清空全部数据）
```

## 二、本机直接运行（不用 Docker）

前置：Node.js ≥ 20。better-sqlite3 会优先下载预编译二进制；若本机无编译环境且无法访问 GitHub，可使用 npmmirror 镜像：

```bash
# 安装依赖（两种方式任选）
npm ci || npm install
# 若卡在 better-sqlite3 预编译下载，可指定镜像后重试：
# npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3 npm install

# 可选：初始化演示数据
npm run seed

# 启动
npm start
# → http://localhost:3000
```

运行自检（需先启动服务）：

```bash
node test/e2e.js
```

---

## 三、使用流程

界面分两个标签页：

1. **素材与来源**
   - 登记素材（名称、类型、备注）。
   - 维护来源关系：「本素材 使用了 ← 来源素材」。关系按边逐条核验，添加会成环的边将被拒绝并提示完整闭环。
   - 登记授权：媒介、地区、有效期（起止日期）、撤销状态、授权方。媒介或地区填 `*` 表示通配任意值；匹配忽略大小写；有效期按闭区间覆盖整段使用期（`valid_from <= 使用起始` 且 `valid_to >= 使用截止`），已撤销授权一律不计入。
2. **展览包与核验发布**
   - 新建待发布包：默认是**单站展**，填展示媒介、地区、起止日期，勾选入展素材（系统会自动纳入其全部上游来源节点）。
   - 勾选「**多站巡展**」后切换为按站编排：逐站填写**站点名称、展示媒介、展示地区、起止日期**，可增删任意站数（至少 2 站）。站按表格顺序展出，**相邻站不得重叠**（首尾日期均算占用：后一站起始日须晚于前一站截止日）；整包共享同一份勾选的入展素材清单。多站行程仅在包处于待发布时可改，发布后冻结。
   - 点「核验」：
     - 单站包：沿每个入展品的**全部**来源路径遍历，逐节点检查是否至少有一份“未撤销 + 媒介命中 + 地区命中 + 覆盖整段使用期”的授权。
     - 多站包：共享来源链只遍历一次，然后**逐站**用该站自己的媒介/地区/展期判定。结果按站列出本站结论，失格站下展开问题节点、原因（无授权 / 全部撤销 / 媒介不符 / 地区不符 / 日期不覆盖（短授权不可拼接）/ 成环）及该节点的**全部来源路径**（入展品 → … → 问题节点）；任一站失格则整包不合格。
     - 行程层面的全局错误（缺站名/媒介/地区、日期不合法或倒置、站间重叠）会在顶部逐条列出并标出站次。
   - 点「**授权报价预览**」（待发布 / 需复核包的表单按钮，或包卡片上的同名按钮）：
     - 在弹层中逐行录入拟取得的报价（素材/媒介/地区/起止日/非负整数成本），点「求最低成本组合」；页面展示最优方案（总成本、所选报价及每项覆盖的站×节点、逐站逐节点的现有授权/所选报价依据、未选用报价），或无解时按站列出缺口节点、各项报价失配原因与来源路径，并可一键把缺口站参数带入新报价行继续试算。
     - 预览纯只读，关闭弹层即结束；已发布包按钮不出现（接口同样拒绝）。
   - 点「**替代素材方案**」（仅待发布包卡片上的按钮）：
     - 在弹层中至多为 6 件包内原素材逐组挑选 1～8 件现有候选（可增删组、增删候选；编号即候选顺序），点「枚举并预览最优方案」；页面展示替换明细、替换后去重清单、逐站核验结果与并列裁决依据，或无解时展示当前清单逐站缺口。
     - 预览只读；点「确认并应用所选清单」才在同一事务内核版本/双指纹、重算并原子替换清单（包仍为待发布，行程与状态不变）；过期或漂移会提示重新预览。
   - **联展批次发布**（「展览包与核验发布」页下方「组建联展批次并预览」）：
     - 勾选 **2～20 个待发布包**（已发布/需复核包置灰不可选），点「逐包预览核验」：弹层按包展示单站或多站**逐站核验**、共同依据版本与各包清单/行程指纹；有包失格即按包列出缺口且不出现确认按钮；预览只读、不写入数据。
     - 全部合格后点「确认整批发布（同一事务）」：服务端核对包集合、待发布状态、共同依据版本与各包双指纹并重算全部包，全部合格才一起封存不可变快照与签名凭证、转为已发布；过期/漂移/失格会提示整批拒绝（无部分发布），重新预览即可。
   - 点「按此次核验结果原子发布」：
     - 服务端在**单个事务内重新读取并重算**——多站包会重读**完整行程（`package_stops`）、素材清单与授权依据**，逐站重算；任一不符或任一站不合格都整体回滚，**整包不发布**。
     - 核验之后授权或来源关系被任何人修改过，返回 `409 STALE_BASIS`，拒绝发布并提示重新核验；
     - 核验不通过（含某站缺授权、行程非法、站间重叠等）返回 `422`，包保持“待发布”，但本次尝试同样留存为不可变记录；
     - 通过则在**单个 SQLite 事务**内写入不可变核验快照（多站：完整**逐站逐节点**结果 JSON + 冻结行程与清单 + 依据版本）并置为“已发布”，同时冻结各站（非待发布包的站次表被触发器拒绝改/删）。

### 授权变更后的行为（先预演、再确认）

- 授权的**单笔增/改/撤/删**或来源关系的**单条增/删**，界面默认「先做影响预演，再确认提交」（右上角开关可关闭，关闭后走既有编辑接口直接保存，行为与旧版一致）。
- 预演输入字段沿用对应现有编辑接口与校验（媒介/地区非空、日期合法且起不晚于止、不得自环、新增来源不得成环等）；**预演只读**，在回滚型事务中模拟变更并重算，只返回：
  - 因该变更将**由合格转为不合格的已发布展览包**（需复核包/待发布包不在其列）；
  - **单站包**：问题节点、原因（无授权 / 全部撤销 / 媒介不符 / 地区不符 / 日期不覆盖等）及全部来源路径；
  - **多站包**：`multiStop:true` + `failingStops`，**按站**列出因此失格的站次（只含失格站）、每站的媒介/地区/展期与该站的问题节点、原因及全部来源路径；
  - 预演所依据的 `basisVersion` 与影响清单指纹；预演**不改动**授权、关系、行程、包状态或快照，依据版本也不变。
- 确认时把**同一操作字段连同预演结果**（`basisVersion` + `impact`）一起提交。服务端在**单个事务内**：核对依据版本 → 重新校验输入/目标/成环 → 应用变更并重算影响 → 与预演清单比对 → 全部通过才提交。任一不符整体回滚、**无部分写入**：
  - 依据版本不一致 → `409 STALE_BASIS`；
  - 影响清单与重算结果不一致 → `409 IMPACT_MISMATCH`（响应里附服务端最新影响清单）；
  - 预演后目标（授权/来源边）被删除或素材失效 → `409 TARGET_GONE`；
  - 输入非法 → `400`；成环 → `409 CYCLE`（含 `cyclePath`/`cycle`）。
  - 界面在过期/漂移时给出过期提示并可一键「重新预演」后再确认。
- 成功后按现有规则执行：变更落库、仅把“合格→不合格”的已发布包置为 `needs_review` 并**追加**不可变复核快照；原发布快照一行不改、不会删除。
- 需复核包不会自动恢复。补正授权后，在界面点「重新核验（人工复核）」：单站包合格即恢复为已发布；**多站包须全部站点合格**才恢复，只要还有一站失格就保持需复核；两种结果都会再追加一条快照。
- 已有编辑接口（直接增删改）的请求与返回保持兼容；已发布/需复核包的参数、清单与（多站）行程仍不可编辑、不可删除，需要调整时点「复制为待发布包」——多站行程会随副本复制，副本为待发布，可继续编排。

### 多站巡展（为待发布包编排多站行程）

- 仅**待发布**包可编排多站行程（至少 2 站）；单站包依旧使用包顶层媒介/地区/起止日期。既有包（含旧版本创建的包）一律视为单站：DTO 为 `multiStop:false, stopCount:0, stops:[]`，请求与响应字段均保持兼容。
- 每站独立填写 `name`（站点名称）、`media`（展示媒介，兼容 `medium`）、`region`（地区）、`useFrom`/`useTo`（起止日期）；站按提交顺序展出。
- **站间不得重叠**：首尾日期均算占用，相邻站必须满足 `后一站.useFrom > 前一站.useTo`（同日衔接也算重叠，保存时返回 `409 STOPS_OVERLAP` 并指出是哪两站）。
- 整包共享一份入展素材清单（及其全部来源链）；来源结构只遍历一次，各站复用同一份全部来源路径。
- **逐站核验**：每个节点在每个站都必须有**一份**未撤销、媒介命中（`*` 通配、忽略大小写）、地区命中、有效期闭区间覆盖**该站整段展期**的授权。不同站可以命中不同授权；同一站不能用多份短授权拼接。
- 多站包**不适用**档期搜索/改期：对多站包调用档期接口返回 `409 MULTI_STOP_UNSUPPORTED`；档期搜索仍然只服务于单站包。
- 编辑已保存的多站待发布包时，请求体必须继续携带完整 `stops`（否则 `400 STOPS_REQUIRED`）；单站与多站形态不能互相转换，需要改形态请新建包。

### 档期规划（仅单站包：为待发布包选可用起始日）

策展人可为**待发布单站**包输入规划起止日，系统按包**当前展期天数（含首尾）**，在规划窗口内查找**完整落在窗口内**的可用起始日（**多站巡展包调用本接口会被明确拒绝：`409 MULTI_STOP_UNSUPPORTED`**）：

- 对**入展素材及其全部上游来源节点**逐一判定：每个起始日对应的展期，节点必须被**同一份**未撤销、媒介与地区匹配（`*` 通配、忽略大小写）的授权**完整覆盖**（闭区间）。不同节点可以用不同授权；同一节点的**短授权不可拼接**——每份授权按展期天数折算为一段可行起始日区间（`valid_from ≤ 起始日` 且 `valid_to ≥ 起始日 + 天数 − 1`），不足整段的短授权折算为空。
- 结果按日期**升序合并连续可行起始日**，逐段给出范围与该段的**最早展期**；窗口放不下整段展期时明确提示窗口过短。
- **无结果**时，列出各**受限节点在窗口内各自的可用起始日范围**（及无授权/全撤销/媒介不符/地区不符/短授权不可拼接等原因），用以解释各节点范围的交集为何为空；全窗口都可用的节点不构成约束，不列出。
- 空包、包当前展期缺失或非法、规划窗口非法均直接报 `400`；已发布/需复核包搜索档期报 `409 NOT_DRAFT`（请用「复制为待发布包」）。

**选定档期**时把搜索返回的 `searchToken` 与起始日回传，服务端在**单个事务内重验**，下列任一变化都**整体拒绝且不改包**：

| 拒绝码 | 触发条件 |
| --- | --- |
| `409 STALE_BASIS` | 搜索后授权或来源关系被增删改（核验依据版本变化） |
| `409 PACKAGE_CHANGED` | 搜索后包参数（媒介/地区/展期）或素材清单被修改（或被清空） |
| `409 NOT_DRAFT` | 包已不再是待发布状态（已被发布等） |
| `409 SLOT_INVALID` | 选定起始日落出搜索窗口，或其展期在当前授权下已不被完整覆盖（附失效节点） |
| `409 TOKEN_MISMATCH` | 搜索令牌不属于该包或内容损坏 |

改期只更新待发布包的起止日期（展期天数保持不变），不发布、不写核验快照、不动清单；随后仍走既有「核验 → 发布」流程。

### 授权报价组合预览（只读，不写入任何数据）

策展人为**待发布或需复核**的包录入若干「拟取得的授权报价」，每项注明：**素材（`materialId`）、媒介（`media`，兼容 `medium`）、地区（`region`）、有效期（`validFrom`/`validTo`）与非负整数成本（`cost`）**，可附带 `licensor`/`note`。系统基于**同一份当前授权与来源关系**求解最优报价组合：

- 覆盖要求与既有核验完全一致：每站每个入展素材及其**全部来源节点**，都必须由**一份**现有有效（未撤销、媒介/地区命中、闭区间覆盖整站展期）授权，**或一份**所选报价独自覆盖整段展期；媒介/地区填 `*` 通配任意值（忽略大小写）；**同一站同一节点不得用多份短授权或多份短报价拼接**，不同站可以由不同报价覆盖。
- **共享节点只核算一次**：来源链只遍历一次；同一份报价可同时覆盖同一节点在多个站的需求（多站包）或多个维度，费用只计一次。
- 最优准则：**总成本最低**；总成本并列时取**报价数少**者；仍并列时按报价**输入序号（从 0 起）序列取字典序最小**（如 `[0,2]` 优于 `[1,2]`）。求解为精确的带权集合覆盖算法（单例强制 + 支配消解 + MRV 分支定界 + 记忆化），不是近似解。
- **无解**时按站（多站）列出仍缺授权的节点：该节点现有授权的失格原因（无授权/全撤销/媒介/地区/有效期）、指向该节点的**每项报价为何不能独自覆盖本站**（媒介/地区/有效期不匹配）以及该节点的**全部来源路径**；没有任何报价指向的节点会明确提示。网页上可一键把缺口站的媒介/地区/展期带入新报价行继续试算。
- **拒绝预览（不落任何数据）**：报价指向不存在的素材、字段缺失（媒介/地区/日期/成本）、日期非法或起止倒置、成本不是非负整数 → `400 INVALID_QUOTES`（逐行列出全部问题）；来源链无法完整核验（成环/超深/路径截断/入展素材缺失）→ `422 UNVERIFIABLE`；空包 → `400 EMPTY_PACKAGE`；**已发布包** → `409 PACKAGE_PUBLISHED`；包不存在 → `404`；多站行程重叠/包参数非法也会先被拒绝。
- 预览**只读**：不写入授权、包、包状态或任何快照，依据版本（`basisVersion`）保持不变；返回结果自带 `mutated:false`。需复核包可预览（用于测算补授权成本），但预览不会改变其状态。
- 现有授权已覆盖全部需求时，允许传空报价数组，返回可行且**总成本 0**、选中 0 项。

---

## 四、核验规则要点

| 规则 | 说明 |
| --- | --- |
| 来源方向 | 边 `素材 → 来源素材`；核验自入展品沿边向上游遍历全部路径 |
| 成环 | 新增边前做可达性预判（若来源已能到达本素材则拒绝）；核验时 DFS 再次检测并把环上节点列为不合格 |
| 授权命中 | 未撤销；媒介相等或授权媒介为 `*`；地区相等或授权地区为 `*`（忽略大小写） |
| 日期覆盖 | `授权.valid_from ≤ 使用起始` 且 `授权.valid_to ≥ 使用截止`（闭区间） |
| 节点合格（单站） | 至少一份授权同时满足上述全部条件（单份授权必须独自覆盖整段使用期，不跨授权拼接） |
| 多站核验 | 整包共享清单与来源链，**逐站**判定；每站每个节点须有一份未撤销授权独自覆盖**该站**整段展期；不同站可用不同授权，同站短授权不可拼接；**任一站失格即整包不合格** |
| 站间不重叠 | 站按顺序展出，首尾日均占用：`stops[i+1].useFrom > stops[i].useTo`，否则保存/核验失败 |
| 行程冻结 | 多站行程仅待发布可改；`package_stops` 上的 `BEFORE UPDATE/DELETE` 触发器拒绝改动非待发布包的站次 |
| 发布闸门 | 无全局错误、无缺失素材、无环、无不合格节点（多站：全部站全部节点），且依据版本未过期 |
| 报价组合预览 | 只读，不写入任何数据；每站每节点须由一份现有授权或一份所选报价独自覆盖整段展期；同站不可拼接短授权/短报价；共享节点（含跨站）一份报价只计一次；最优=总成本最低→报价数少→输入序号序列字典序最小；已发布包不可预览 |
| 替代素材方案 | 仅待发布包；至多 6 件原素材各带 1～8 件现有候选，重复编号/非包内原素材/不存在候选整次拒绝；恰选一件、按替换后去重清单重算完整来源链与逐站资格；仅全站合格方案可选，替换件数最少→最终清单升序→原顺序选中编号；预览只读；确认同事务核对状态/依据版本/双指纹并重算，任一不符整体拒绝 |
| 联展批次发布 | 2～20 个待发布包成批；预览按包给出单站/多站逐站结果、共同依据版本与各包清单/行程指纹，有包失格即列缺口且不发凭据、禁止确认、不写入；确认携带凭据，同事务核对包集合/待发布状态/依据版本/各包指纹并重算全部包，全部合格才逐包封存不可变快照+签名凭证（`publish-batch`）并一起转已发布；包不存在/凭据不符/状态或依据变化/任一包失格整批拒绝，无快照、凭证或部分发布；单包发布与其 422 失败留痕、凭证导出保持兼容 |

不可变性由数据库强制：`verification_snapshots` 表与多站包发布后的 `package_stops` 行上配置了 `BEFORE UPDATE` / `BEFORE DELETE` 触发器，任何修改或删除都会被 SQLite 直接拒绝。

## 五、配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | 本地 `./data/app.db`（容器内 `/data/app.db`） | SQLite 数据库文件路径，所在目录自动创建 |
| `SEED_DEMO` | `0`（compose 中为 `1`） | 启动时若库为空则写入演示数据 |
| `ATTEST_KEY_DIR` | `<数据库目录>/attestation-keys`（容器内 `/data/attestation-keys`），无 `DB_PATH` 时为 `~/.exhibit-attestation` | 本机持久化签名密钥与公钥归档目录（首次签发惰性生成；请与数据库一同备份） |

修改端口（例如改为 8080）：编辑 `docker-compose.yml` 的 `ports: - "8080:3000"`（宿主机端口:容器端口），或直接运行时 `-e PORT=...` 并同步映射。

## 六、数据持久化与备份

- Compose 使用命名卷 `exhibit-data` 挂载到容器 `/data`，数据库（WAL 模式）在 `docker compose down` 后仍然保留。
- 备份：`docker compose exec exhibit-auth node -e "const db=require('better-sqlite3')(process.env.DB_PATH);db.backup('/data/backup.db').then(()=>process.exit(0))"` 后从卷中取 `/data/backup.db`；或停服后直接复制 `app.db`、`app.db-wal`、`app.db-shm`。

## 七、主要 HTTP API

| 方法 路径 | 作用 |
| --- | --- |
| `GET /api/state` | 依据版本与计数 |
| `GET/POST /api/materials` · `PATCH/DELETE /api/materials/:id` | 素材 CRUD |
| `POST /api/materials/:id/sources` · `DELETE /api/source-links/:id` | 来源关系（成环返回 409 + `cyclePath`/`cycle`） |
| `POST /api/materials/:id/authorizations` · `PATCH /api/authorizations/:id` · `POST /api/authorizations/:id/revoke` · `DELETE` | 授权登记/修改/撤销/删除 |
| `GET/POST /api/packages` · `PATCH/DELETE /api/packages/:id` · `POST /api/packages/:id/copy` | 展览包（POST/PATCH 传 `stops` 数组即多站包；`copy` 会复制行程） |
| `POST /api/verify` | 试核验（body 可传 `packageId`、单站完整字段，或 `{materialIds, stops[]}` 即席多站核验） |
| `POST /api/packages/:id/schedule/search` | **档期搜索（仅单站）**：多站包返回 `409 MULTI_STOP_UNSUPPORTED` |
| `POST /api/packages/:id/schedule/apply` | **选定档期改期（仅单站）**：多站包同样 `409 MULTI_STOP_UNSUPPORTED` |
| `POST /api/packages/:id/publish` | 发布，body 需含核验时的 `basisVersion`；事务内重读行程/清单/依据，过期 409、任一站不合格 422；成功 201 在同一事务内封存签名发布凭证（`attestation`） |
| `GET /api/packages/:id/attestation` · `GET /api/attestations/by-snapshot/:snapshotId` | 导出已封存发布凭证（`?download=1` 带附件头） |
| `POST /api/attestations/reissue` | 旧成功发布快照补发凭证（只读快照自身；缺证明字段 422 `UNSUPPORTED_SNAPSHOT`；幂等） |
| `GET /api/attestation-keys` · `POST /api/attestation-keys/rotate` | 本机签名公钥（当前+历史归档）查询 / 密钥轮换（旧公钥保留） |
| `POST /api/packages/:id/recheck` | 对需复核包人工重新核验 |
| `POST /api/changes/preview` | **变更影响预演**（只读）：单笔授权增改撤删 / 单条来源增删，返回将由合格转不合格的已发布包、问题节点、原因与依据版本 |
| `POST /api/changes/commit` | **确认提交同一操作 + 预演结果**：事务内核版本、重算并比对影响清单；过期/不一致/目标失效/非法均整体拒绝 |
| `POST /api/packages/:id/quotes/preview` | **授权报价组合预览（只读）**：求总成本最低的报价组合覆盖全部站次全部来源节点；无解列出站次/节点/来源路径缺口；不写入任何数据；已发布包 `409 PACKAGE_PUBLISHED` |
| `POST /api/packages/:id/substitutes/preview` | **替代素材方案预览（只读）**：至多 6 件包内原素材各带 1～8 件现有候选，枚举恰选一件的全部组合，取替换最少→最终清单升序→原顺序选中编号的全站合格最优方案；无解返回当前清单逐站缺口 |
| `POST /api/packages/:id/substitutes/apply` | **确认应用替代方案**：同一事务内核对待发布状态、依据版本、清单/行程指纹并重算最优方案；过期/输入不符/重算失格均整体拒绝，不部分修改 |
| `POST /api/batches/preview` | **联展批次预览（只读）**：body `{packageIds:[2～20 个包]}`，按包返回单站/多站逐站核验、共同依据版本、各包清单/行程指纹；有包失格不列确认凭据；不写入任何数据 |
| `POST /api/batches/confirm` | **联展批次整批发布**：body `{confirmToken}`（原样回传预览凭据）；单事务核对包集合/待发布状态/依据版本/各包指纹并重算全部包，全部合格才逐包封存不可变快照+签名凭证并一起转已发布；任一不符整批拒绝，无快照/凭证/部分发布 |
| `GET /api/snapshots/:id` | 读取不可变快照完整内容 |

### 多站巡展 API 调用示例

新建/保存待发布包时，除顶层 `name` 与 `materialIds`（整包共享）外，传 `stops` 数组（≥2 站）即为多站包；不传 `stops` 即既有单站包（兼容）。

第 1 步——创建多站待发布包：

```bash
curl -s -X POST http://localhost:3000/api/packages \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "2026 双城巡展包",
    "materialIds": [1],
    "stops": [
      { "name": "北京首展", "media": "屏幕放映",   "region": "中国大陆",
        "useFrom": "2026-03-01", "useTo": "2026-03-20" },
      { "name": "香港巡展", "media": "沉浸式投影", "region": "中国香港",
        "useFrom": "2026-05-01", "useTo": "2026-05-20" }
    ]
  }'
# → { "id": 12, "multiStop": true, "stopCount": 2, "stops": [ {position:0,…}, {position:1,…} ],
#     "medium": "屏幕放映", "useFrom": "2026-03-01", …  /* 顶层字段取首站，供旧界面展示 */
#     "items": [ …整包共享清单… ] }
```

第 2 步——逐站核验（`/api/verify` 传 `packageId` 自动按存储形态走单站或多站；也可不建包直接传 `materialIds + stops` 即席核验）：

```bash
curl -s -X POST http://localhost:3000/api/verify -H 'Content-Type: application/json' \
  -d '{"packageId": 12}'
# → { "multiStop": true, "eligible": false, "basisVersion": 22,
#     "globalErrors": [],
#     "stats": { "stopCount": 2, "failingStopCount": 1, "rootCount": 1, "nodeCount": 5, … },
#     "stops": [
#       { "position": 0, "name": "北京首展", "medium": "屏幕放映", "region": "中国大陆",
#         "useFrom": "2026-03-01", "useTo": "2026-03-20", "eligible": true, "failingNodes": [], "nodes": [ … ] },
#       { "position": 1, "name": "香港巡展", "medium": "沉浸式投影", "region": "中国香港",
#         "useFrom": "2026-05-01", "useTo": "2026-05-20", "eligible": false,
#         "failingNodes": [
#           { "materialId": 4, "title": "标题字体“展宋”", "isRoot": false,
#             "reasons": ["date"], "reasonText": ["该站：无任何一份授权能独自覆盖该站整段展期（短授权不可拼接）"],
#             "paths": [ [ {"materialId":1,…}, {"materialId":4,…} ] ] } ] } ] }
```

第 3 步——整包发布（同一事务内重读行程、清单与授权依据；任一站失败则整包不发布）：

```bash
curl -s -X POST http://localhost:3000/api/packages/12/publish \
  -H 'Content-Type: application/json' -d '{"basisVersion": 22}'
# 全站合格 → 201：package.status="published"，result.multiStop=true，
#   result.stops[*] 冻结各站逐节点结果，result.request.stops 冻结行程，result.request.materialIds 冻结清单。
# 任一站失格 → 422（details.result 为完整逐站结果，包保持 draft，本次尝试仍追加不可变快照）。
# 核验后授权/来源有变更 → 409 STALE_BASIS。
```

多站包的拒绝码（均为 4xx，不产生部分写入）：

```text
400  INVALID_STOPS     stops 缺字段/不足 2 站、某站名/媒介/地区缺失、日期非法或倒置
409  STOPS_OVERLAP     相邻站展期重叠（首尾日均占用，后站起始须晚于前站截止）
400  STOPS_REQUIRED    编辑已保存的多站包时未提交完整 stops
409  MULTI_STOP_UNSUPPORTED  多站包调用档期搜索/改期（档期仅适用于单站）
409  STALE_BASIS / 422 …     发布闸门与单站一致，按“全站合格”判定
```

多站包的变更预演影响按站返回（`POST /api/changes/preview`）：

```jsonc
{ "operation": "authorization.revoke", "basisVersion": 22, "impact": [
  { "packageId": 12, "packageName": "2026 双城巡展包", "multiStop": true, "stopCount": 2,
    "failingStops": [
      { "position": 1, "name": "香港巡展", "medium": "沉浸式投影", "region": "中国香港",
        "useFrom": "2026-05-01", "useTo": "2026-05-20",
        "failingNodes": [ { "materialId": 4, "reasons": ["date"], "reasonText": ["…"], "paths": [ … ] } ] }
    ] } ] }
```

人工复核（`POST /api/packages/12/recheck`）对多站包要求**全部站点**合格才恢复为已发布，否则保持需复核；每次复核都追加一条 `recheck` 不可变快照。

### 影响预演 / 确认 API 调用示例

请求体里的 `operation` 标识操作类型，其余字段与对应既有编辑接口完全一致。

| operation | 对应既有接口 | 关键入参 |
| --- | --- | --- |
| `authorization.create` | `POST /api/materials/:id/authorizations` | `materialId, media, region, validFrom, validTo, revoked?, licensor?, note?` |
| `authorization.update` | `PATCH /api/authorizations/:id` | `authorizationId` + 需修改字段（缺省沿用现值，含 `revoked`） |
| `authorization.revoke` | `POST /api/authorizations/:id/revoke` | `authorizationId` |
| `authorization.delete` | `DELETE /api/authorizations/:id` | `authorizationId` |
| `source.create` | `POST /api/materials/:id/sources` | `materialId, sourceMaterialId, relation?` |
| `source.delete` | `DELETE /api/source-links/:id` | `linkId` |

第 1 步——预演（不落库）：

```bash
curl -s -X POST http://localhost:3000/api/changes/preview \
  -H 'Content-Type: application/json' \
  -d '{"operation":"authorization.revoke","authorizationId":3}'
# → { "ok": true, "basisVersion": 10,
#     "impact": [ { "packageId": 1, "packageName": "常设展…",
#                   "failingNodes": [ { "materialId": 3, "title": "城市航拍素材",
#                                       "reasons": ["revoked"],
#                                       "reasonText": ["该节点的授权均已撤销"],
#                                       "paths": [ [ {"materialId":1,…}, {"materialId":3,…} ] ] } ] } ],
#     "impactFingerprint": "…", "mutated": false }
```

第 2 步——把**同一操作字段**连同预演给出的 `basisVersion` 与 `impact` 原样回传确认：

```bash
curl -s -X POST http://localhost:3000/api/changes/commit \
  -H 'Content-Type: application/json' \
  -d '{"operation":"authorization.revoke","authorizationId":3,
       "basisVersion":10,"impact":[ /* 原样粘贴 preview 返回的 impact */ ]}'
# → { "ok": true, "mutated": true, "basisVersion": 11, "impact": [ …同清单… ],
#     "message": "变更已执行：1 个已发布包被标记为需复核并已追加不可变复核快照；需复核包不会自动恢复。" }
```

新增来源边的预演（成环在预演阶段即被拒绝）：

```bash
curl -s -X POST http://localhost:3000/api/changes/preview \
  -H 'Content-Type: application/json' \
  -d '{"operation":"source.create","materialId":1,"sourceMaterialId":6,"relation":"引用"}'
```

可能的拒绝（均为 4xx，且不产生任何写入）：

```text
400  输入非法（空媒介/地区、日期非法或倒置、自环、缺少 id、未知 operation）
409  CYCLE           新增来源将成环（details.cyclePath / details.cycle）
409  STALE_BASIS     预演后授权/来源被他人改过（details.clientBasis/currentBasis）
409  IMPACT_MISMATCH 影响清单与当前重算不符（details.impact 为最新清单，请重新预演）
409  TARGET_GONE     预演后目标授权/来源边已被删除
404  预演时目标不存在
```

### 档期规划 API 调用示例

第 1 步——为待发布包搜索可用起始日（只读）：

```bash
curl -s -X POST http://localhost:3000/api/packages/12/schedule/search \
  -H 'Content-Type: application/json' \
  -d '{"planFrom":"2026-06-01","planTo":"2026-09-30"}'
# → { "ok": true, "durationDays": 7, "feasible": true,
#     "ranges": [
#       { "startFrom": "2026-07-10", "startTo": "2026-08-09", "dayCount": 31,
#         "earliestExhibitionFrom": "2026-07-10", "earliestExhibitionTo": "2026-07-16" }
#     ],
#     "restrictedNodes": [],
#     "basisVersion": 22,
#     "searchToken": { "packageId": 12, "basisVersion": 22, "fingerprint": "…",
#                      "planFrom": "2026-06-01", "planTo": "2026-09-30", "durationDays": 7 } }
```

无结果时 `feasible:false`，`restrictedNodes` 给出每个受限节点在窗口内的可用起始日范围以解释交集；窗口过短时 `windowTooShort:true`。

第 2 步——选定某段范围内的起始日应用（在事务内重验）：

```bash
curl -s -X POST http://localhost:3000/api/packages/12/schedule/apply \
  -H 'Content-Type: application/json' \
  -d '{"useFrom":"2026-08-09","searchToken":{ /* 原样粘贴 search 返回的 searchToken */ }}'
# → { "ok": true, "useFrom": "2026-08-09", "useTo": "2026-08-15",
#     "durationDays": 7, "package": { …更新后的待发布包… } }
```

拒绝均为 4xx 且不改动包，例如搜索后授权被修改：

```text
400  EMPTY_PACKAGE / INVALID_WINDOW / INVALID_DATE / 缺令牌（空包、非法窗口/日期、缺 searchToken）
409  STALE_BASIS     搜索后授权或来源关系发生变化（details.clientBasis/currentBasis）
409  PACKAGE_CHANGED 搜索后包参数或素材清单发生变化
409  NOT_DRAFT       包已发布或处于需复核
409  SLOT_INVALID    选定起始日落出窗口或档期已失效（details.failingNodes 为失效节点）
409  TOKEN_MISMATCH  搜索令牌与目标包不一致或已损坏
```

> 注意：应用成功后 `searchToken` 即作废（包展期已变），需要再次改期请重新搜索。

### 授权报价组合预览 API 调用示例

第 1 步——对待发布（或需复核）包提交报价列表（`quotes` 数组，序号即数组下标，从 0 开始）：

```bash
curl -s -X POST http://localhost:3000/api/packages/2/quotes/preview \
  -H 'Content-Type: application/json' \
  -d '{ "quotes": [
    { "materialId": 4, "media": "*", "region": "*",
      "validFrom": "2026-09-01", "validTo": "2026-12-31", "cost": 100,
      "licensor": "字库公司", "note": "拟取得的字体展期授权" },
    { "materialId": 5, "media": "屏幕放映", "region": "中国大陆",
      "validFrom": "2026-10-01", "validTo": "2026-11-30", "cost": 200 }
  ]}'
# → 200 { "ok": true, "feasible": true, "mutated": false, "basisVersion": 10,
#     "multiStop": false, "stopCount": 1, "totalCost": 300, "quoteCountSelected": 2,
#     "selectedQuotes": [
#       { "index": 0, "materialId": 4, "materialTitle": "标题字体“展宋”",
#         "media": "*", "region": "*", "validFrom": "2026-09-01", "validTo": "2026-12-31",
#         "cost": 100, "coverCount": 1,
#         "covers": [ { "stopPosition": 0, "materialId": 4, "materialTitle": "标题字体“展宋”" } ] },
#       { "index": 1, … "cost": 200, "coverCount": 1 } ],
#     "unselectedQuotes": [],
#     "coverage": [ { "position": 0, "name": "…", "nodes": [
#         { "materialId": 1, "title": "…", "coveredBy": { "kind": "existing", "authorizationId": 1 } },
#         { "materialId": 4, "coveredBy": { "kind": "quote", "quoteIndex": 0, "cost": 100 } }, … ] } ],
#     "stats": { "nodeCount": 5, "requirementCount": 2, "existingCoveredCount": 3,
#                "quoteCount": 2, "gapCount": 0 } }
```

多站包——一份全域报价可同时覆盖同一来源节点在多站的需求，**费用只核算一次**；同成本时报价数少者胜：

```bash
curl -s -X POST http://localhost:3000/api/packages/12/quotes/preview \
  -H 'Content-Type: application/json' \
  -d '{ "quotes": [
    { "materialId": 7, "media": "*", "region": "*",
      "validFrom": "2026-01-01", "validTo": "2030-12-31", "cost": 200 },
    { "materialId": 7, "media": "沉浸式投影", "region": "中国香港",
      "validFrom": "2026-05-01", "validTo": "2026-05-31", "cost": 100 },
    { "materialId": 7, "media": "屏幕放映", "region": "中国大陆",
      "validFrom": "2026-07-01", "validTo": "2026-07-31", "cost": 100 }
  ]}'
# → feasible:true，totalCost:200，quoteCountSelected:1：
#   报价 #0 一份同时覆盖香港、上海两站（selectedQuotes[0].coverCount === 2，
#   covers 含 stopPosition 1、2），与两份 100 同成本但报价数更少故取胜。
```

无解时 `feasible:false`、`totalCost:null`，`gaps` 按站给出节点、现有授权原因、每项报价的失配维度（`media`/`region`/`date`）与全部来源路径：

```jsonc
{ "feasible": false, "gapCount": 1,
  "gaps": [ { "position": 0, "name": "临时展", "medium": "屏幕放映", "region": "中国大陆",
              "useFrom": "2026-10-01", "useTo": "2026-11-30", "missingCount": 1,
    "nodes": [ { "materialId": 5, "title": "历史照片（馆藏扫描）", "isRoot": false,
      "existingReason": "date",
      "existingReasonText": "授权有效期不覆盖整段使用期",
      "noQuoteForNode": false,
      "quoteFailures": [ { "index": 0, "media": "屏幕放映", "region": "中国大陆",
        "validFrom": "2026-10-01", "validTo": "2026-11-15", "cost": 50,
        "misses": ["date"],
        "missText": ["报价有效期不能独自覆盖该站整段展期（短报价不可拼接）"] } ],
      "paths": [ [ {"materialId":1,"title":"…"}, {"materialId":3,"title":"…"},
                   {"materialId":5,"title":"历史照片（馆藏扫描）"} ] ] } ] } ] }
```

拒绝（均为 4xx，且不产生任何写入；错误明细在 `details`）：

```text
400  INVALID_QUOTES  quotes 缺失/不是数组；逐项报价引用不存在素材、缺媒介/地区、
                      日期非法或倒置、成本不是非负整数（details.errors 逐行列出）
400  EMPTY_PACKAGE   包未选取任何入展素材
409  PACKAGE_PUBLISHED  已发布包不可预览（待发布 / 需复核包可以）
409  STOPS_OVERLAP   多站包行程存在站间重叠
422  UNVERIFIABLE     来源链无法完整核验：成环 / 超深 / 路径截断 / 入展素材缺失
404  展览包不存在
```

> 报价预览完全只读：调用前后 `/api/state` 的 `basisVersion` 与授权数量不变，包状态与快照表均无变化；报价不会变成真实授权，后续仍由策展人按现有「授权登记 → 核验 → 发布」流程执行。

### 替代素材方案：只读预览 / 事务确认（仅待发布包）

策展人可为**待发布**包中至多 **6** 件入展素材分别指定 **1～8** 件**现有**替代素材。每组语义为“这件原素材及其候选中**恰选一件**”（选编号 0＝保持原素材，编号 1..8＝选该顺位候选）；未出现在请求里的原素材一律保持不变。

- **整次拒绝（`400 INVALID_SUBSTITUTIONS`，逐组列出全部问题，不做任何修改）**：
  - 同一原素材 `materialId` 出现多组（**重复编号**）；
  - `materialId` 不在当前包入展清单内（**非包内原素材**）；
  - 候选 `candidateIds` 为空、少于 1 或多于 8 件、含非正整数、含不存在素材、含原素材自身、或同组内候选重复（**不存在的候选 / 重复编号**）。
  - 不同组之间候选允许相同（重复由“替换后去重清单”自然折叠）。
- **预览只读重算**：对全部“恰选一件”组合（保持不变也视为方案之一），把每件原素材替换为所选素材后，**沿原清单顺序首次出现去重**，再以去重清单（id 升序）为入展根集合重算**完整来源闭包**与**单站或多站逐站**授权资格——规则与既有核验完全一致（`*` 通配、忽略大小写、闭区间独自覆盖、同站短授权不可拼接）。
- **方案可选条件**：全部站点的全部来源节点合格（多站须**每一站**都合格）。
- **并列裁决（确定性、唯一最优）**：① 替换件数最少（只有“原素材→候选”计替换；去重折叠不计额外替换）；② 替换后最终去重清单（id 升序）字典序最小；③ 原清单顺序上各可替换槽位选中编号序列（0/1..8）字典序最小。
- **无解**：`feasible:false`，不下发确认令牌，返回**当前清单（不替换）**的完整逐站核验 `current` 与按站缺口（失格节点、原因、全部来源路径），**不修改包**。
- 预览返回：替换明细（`selection`/`replacements`/`removedByDedupe`）、`verification` 完整核验结果与 `stops` 逐站结论、`basisVersion`、`originalListFingerprint`、`itineraryFingerprint`、裁决依据 `tieBreak`、枚举方案数 `consideredPlans`，以及一次性的 `applyToken`。
- **确认**在**单个事务**内：校验令牌完整性 → 包仍为 `draft` → `basisVersion` 未变 → 清单指纹与行程指纹均未变 → 令牌内嵌规格仍通过同一套输入校验且选中素材仍存在 → **服务端按同一规格重算最优方案并与令牌逐项比对** → 对最终去重清单再做一次权威整站核验 → 全部通过才原子重写清单（不动行程、状态与快照；包仍为待发布，随后照常「核验 → 发布」）。任一不符整体回滚。

第 1 步——预览（`substitutions` 数组；空数组 `[]` 表示本轮不替换任何素材）：

```bash
curl -s -X POST http://localhost:3000/api/packages/2/substitutes/preview \
  -H 'Content-Type: application/json' \
  -d '{ "substitutions": [
    { "materialId": 1, "candidateIds": [22, 24] }
  ]}'
# → 200 {
#   "ok": true, "feasible": true, "mutated": false,
#   "packageId": 2, "multiStop": false, "stopCount": 1,
#   "basisVersion": 10, "consideredPlans": 3,
#   "originalMaterialIds": [1],
#   "originalListFingerprint": "5345…", "itineraryFingerprint": "569b…",
#   "replacementCount": 1,
#   "finalMaterialIds": [24],
#   "selection": [
#     { "position": 0, "materialId": 1, "materialTitle": "展馆宣传片《城脉》成片",
#       "choiceIndex": 2, "selectedMaterialId": 24, "selectedTitle": "干净替代成片《秋脉》",
#       "replaced": true } ],
#   "replacements": [ { "position": 0, "choiceIndex": 2,
#       "from": {"materialId":1,"title":"…"}, "to": {"materialId":24,"title":"…"} } ],
#   "removedByDedupe": [],
#   "tieBreak": { "first": "replacementCount",
#     "then": ["finalMaterialIdsAsc","choiceSequenceInOriginalOrder"],
#     "replacementCount": 1, "finalMaterialIds": [24], "choiceSequence": [2] },
#   "verification": { …替换后清单的完整核验结果（与 /api/verify 同构）… },
#   "stops": [ { "position": 0, "eligible": true, "nodeCount": 2, "failingNodeCount": 0 } ],
#   "applyToken": { "packageId": 2, "basisVersion": 10, "listFingerprint": "…",
#                   "itineraryFingerprint": "…", "substitutions": [ … ], "selection": [ … ],
#                   "finalMaterialIds": [24], "replacementCount": 1 } }
```

第 2 步——把预览返回的 `applyToken` **原样**回传确认（同一事务重算后原子应用）：

```bash
curl -s -X POST http://localhost:3000/api/packages/2/substitutes/apply \
  -H 'Content-Type: application/json' \
  -d '{ "applyToken": { /* 原样粘贴 preview 返回的 applyToken */ } }'
# → 200 { "ok": true, "mutated": true, "replacementCount": 1,
#         "finalMaterialIds": [24], "basisVersion": 10,
#         "package": { …更新后的待发布包 DTO（items 已为替换后去重清单）… },
#         "result": { …应用后整站重算结果… }, "stops": [ …逐站结论… ] }
```

多站包用法相同：逐站结果在 `stops[]` 按站给出，方案必须**每一站**都合格；确认只替换清单，冻结前的多站行程（`package_stops`）原样保留。当前清单已全站合格时，允许传空 `substitutions` 或让“保持不变”参与裁决——此时最优方案替换件数为 0，确认不会改动清单。

无解示例（当前清单本身在秋季失格，候选也无法补齐）：

```jsonc
// POST /api/packages/2/substitutes/preview  { "substitutions": [ { "materialId": 1, "candidateIds": [22] } ] }
{ "feasible": false, "consideredPlans": 2, "mutated": false,
  "current": { …当前清单 [1] 的完整核验：eligible=false… },
  "stops": [ { "position": 0, "eligible": false, "failingNodeCount": 1,
    "failingNodes": [ { "materialId": 5, "reasons": ["date"],
      "reasonText": ["授权有效期不覆盖整段使用期"],
      "paths": [ [ {"materialId":1}, {"materialId":3}, {"materialId":5} ] ] } ] } ]
  // 注意：无 applyToken；包与任何数据均未改动
}
```

拒绝码（均为 4xx，且不产生任何写入）：

```text
400  INVALID_SUBSTITUTIONS  substitutions 缺失/非数组、超过 6 组；原素材重复编号或不在包内；
                            候选为空 / 超过 8 件 / 同组重复 / 含原素材自身 / 引用不存在素材
                            （details.errors 逐组列出 field 与 message，整次拒绝）
400  EMPTY_PACKAGE          包没有任何入展素材
400  INVALID_PACKAGE / INVALID_STOPS   单站参数或多站行程自身非法
409  NOT_DRAFT              包已发布 / 需复核（清单已冻结；请先「复制为待发布包」）
409  STOPS_OVERLAP          多站行程存在站间重叠
409  STALE_BASIS            预览后授权或来源关系被增删改（依据版本变化；details.clientBasis/currentBasis）
409  PACKAGE_CHANGED        预览后清单被修改（或令牌重复使用）
409  ITINERARY_CHANGED      预览后单站参数或多站行程被修改
409  TOKEN_MISMATCH         确认令牌缺失、损坏或不属于该包
409  INPUT_MISMATCH         令牌方案与服务端按当前数据重算的最优方案不一致（篡改/漂移）
422  RECOMPUTE_DISQUALIFIED 重算最优方案缺失或最终清单重算未达全站合格
404  展览包不存在
```

> 与既有规则的兼容：替代确认只重写**待发布**包的 `package_items`（不触碰授权、来源关系、`package_stops`、快照与依据版本）；已发布 / 需复核包的冻结规则、发布闸门、失败发布留痕、复制为待发布包、档期与报价预览等既有行为均不变。应用成功后旧的 `applyToken` 立即作废（清单指纹已变），需要再次调整请重新预览。

### 联展批次发布 API 调用示例（2～20 个待发布包；预览只读 → 凭据确认、单事务整批发布）

第 1 步——选取 **2～20 个待发布包**做只读预览（`packageIds` 顺序任意，服务端按 id 升序规范化）：

```bash
curl -s -X POST http://localhost:3000/api/batches/preview \
  -H 'Content-Type: application/json' \
  -d '{ "packageIds": [13, 12] }'
# → 200（全部合格时）
# { "ok": true, "mutated": false, "eligible": true, "packageCount": 2,
#   "packageIds": [12, 13], "basisVersion": 22, "eligibleCount": 2, "failingCount": 0,
#   "packages": [
#     { "packageId": 12, "packageName": "2026 双城巡展包", "status": "draft",
#       "multiStop": true, "stopCount": 2, "itemCount": 1, "materialIds": [1],
#       "eligible": true, "basisVersion": 22,
#       "listFingerprint": "5345…", "itineraryFingerprint": "569b…",
#       "stops": [
#         { "position": 0, "name": "北京首展", "medium": "屏幕放映", "region": "中国大陆",
#           "useFrom": "2026-03-01", "useTo": "2026-03-20", "eligible": true,
#           "nodeCount": 5, "failingNodeCount": 0, "failingNodes": [] },
#         { "position": 1, "name": "香港巡展", "eligible": true, … } ] },
#     { "packageId": 13, "multiStop": false, "stopCount": 1, "eligible": true,
#       "listFingerprint": "…", "itineraryFingerprint": "…",
#       "stops": [ { "position": 0, "name": "单站包名", "eligible": true, … } ] }
#   ],
#   "confirmToken": { "kind": "joint-exhibition-batch-confirm",
#     "packageIds": [12, 13], "basisVersion": 22,
#     "packages": [ { "packageId": 12, "listFingerprint": "…", "itineraryFingerprint": "…" },
#                   { "packageId": 13, "listFingerprint": "…", "itineraryFingerprint": "…" } ] } }
```

有包失格时 `eligible:false`、**没有** `confirmToken`，按包给出缺口（单站归一为 1 站；多站逐站列出失格节点、原因与全部来源路径），预览仍不写入任何数据：

```jsonc
// POST /api/batches/preview { "packageIds": [12, 14] }
{ "eligible": false, "failingCount": 1, "eligibleCount": 1,
  "packages": [
    { "packageId": 12, "eligible": true,  /* …同上… */ },
    { "packageId": 14, "eligible": false,
      "stops": [ { "position": 0, "eligible": false, "failingNodeCount": 2,
        "failingNodes": [
          { "materialId": 4, "title": "标题字体“展宋”", "reasons": ["date"],
            "reasonText": ["授权有效期不覆盖整段使用期"],
            "paths": [ [ {"materialId":14,…}, {"materialId":4,…} ] ] } ] } ] }
  ]
  // 无 confirmToken —— 禁止确认
}
```

第 2 步——把预览返回的 `confirmToken` **原样**回传，整批在同一事务内核验并发布：

```bash
curl -s -X POST http://localhost:3000/api/batches/confirm \
  -H 'Content-Type: application/json' \
  -d '{ "confirmToken": { /* 原样粘贴 preview 返回的 confirmToken */ } }'
# → 201：
# { "ok": true, "mutated": true, "packageCount": 2, "packageIds": [12, 13], "basisVersion": 22,
#   "packages": [
#     { "packageId": 12, "snapshotId": 8, "attestationId": 8,
#       "attestation": { …与单包发布同构的自包含签名凭证；body.sealContext="publish-batch"… },
#       "package": { …已转为 published 的完整包 DTO… },
#       "result": { …冻结的多站/单站完整核验结果（即快照 payload）… } },
#     { "packageId": 13, "snapshotId": 9, "attestationId": 9, … } ] }
```

批次内每包封存的快照与凭证与单包发布**完全同构**，既有接口直接可用：

```bash
# 批次发布的凭证可照旧导出并离线校验（封存场景显示 publish-batch）
curl -s http://localhost:3000/api/packages/12/attestation -o attestation-pkg12.json
node scripts/verify-attestation.js attestation-pkg12.json trusted-pubkeys.pem
# → 结论：通过 ✅ … 封存场景：publish-batch
```

拒绝码（均为 4xx；**整批拒绝时不产生任何快照、凭证或部分发布**）：

```text
400  INVALID_BATCH        packageIds 缺失/非数组、数量不在 2～20、含非正整数或重复包号
404  PACKAGE_NOT_FOUND    批次中的某个包不存在（details.packageId）
409  NOT_DRAFT            预览或确认时某包不是待发布状态（已发布/需复核；含凭据重放）
409  TOKEN_MISMATCH       确认凭据缺失、损坏、kind/包集合不一致
409  STALE_BASIS          预览后授权或来源关系被增删改（共同依据版本变化；details.clientBasis/currentBasis）
409  PACKAGE_CHANGED      预览后某包清单或（单站/多站）行程被修改（details.listChanged/itineraryChanged）
422  RECOMPUTE_DISQUALIFIED  确认事务内按当前数据重算后任一包失格（details.packages 附逐站缺口）
```

> 语义与兼容说明：联展批次是一个**原子发布闸门**——确认失败不留任何痕迹（与单包发布失败 `422` 仍追加不可变快照的既有行为刻意区分）；批次不影响**单包发布** `POST /api/packages/:id/publish`（含其 `422` 失败留痕）、凭证导出、旧快照补发与离线校验。批次预览同样是只读的：调用前后 `/api/state` 的 `basisVersion` 不变，包状态与快照表均无变化。

## 八、发布凭证：签发、导出与离线独立校验

发布成功（单站或多站）时，服务端在**写入不可变发布快照、置为已发布的同一个 SQLite 事务内**，同时封存一份自包含、可导出的签名凭证（`publish_attestations` 表，与快照表一样有 UPDATE/DELETE 拒绝触发器）。经**联展批次**整批发布时，批次内每包也在同一个批次事务内各封存一份同构凭证，其 `sealContext` 为 `publish-batch`（单包发布为 `publish`，旧快照补发为 `reissue-from-snapshot`），导出与离线校验方式完全相同。

### 凭证里有什么

| 部分 | 内容 |
| --- | --- |
| `manifest` | 当时的入展素材清单（素材 id） |
| `materials` | 清单与来源闭包内全部节点（id/标题/类型） |
| `sourceSubgraph` | **完整来源子图**：发布当时这些节点之间的全部来源边（`from → to`，含关系标注） |
| `itinerary` | **逐站行程**（单站为 1 站；多站为冻结的全部站：站名/媒介/地区/起止日） |
| `terms` | 每个节点**实际采用**的那份**未撤销授权条款全文**（id、所属素材、媒介、地区、有效期、授权方；显式 `revoked:false`） |
| `adoptions` | **站 × 节点 → 条款**的逐站采用关系（每个站每个节点恰好一份，不拼接） |
| `paths` | 每个节点的**全部来源路径**（从清单素材到该节点，含节点标题） |
| `rules` | **核验规则版本**（`version`）与规则参数（通配符、忽略大小写、闭区间、不可拼接、来源链深度/路径上限） |
| `signature` | 本机持久化密钥对**确定性规范化 JSON（canonical JSON）** 的 Ed25519 签名（含 `kid`） |

凭证同时记录 `basisVersion`、发布快照 id 与快照 payload 的 SHA-256；它不引用数据库里的活数据，因此**授权之后修改/撤销/删除、来源关系变更、包转入需复核，旧凭证一个字节都不会变**。凭证仅在发布成功时封存；发布失败（422）不产生凭证。

### 离线独立校验程序（审计端，脱离馆内数据库）

`scripts/verify-attestation.js` 是**零第三方依赖**的独立程序（只用 Node.js 内置模块），可单独拷贝到审计环境。它**只需要凭证文件和签发方公开密钥**，自行复算：

1. **签名**：用给定公钥（一把或多把；轮换后请提供归档公钥集合）验证 canonical JSON 上的 Ed25519 签名；
2. **来源链**：由清单素材沿封存边独立重算来源闭包（检测成环/超深/路径截断）、核对子图完整性（不可增边漏边、不可有不可达节点），并重算每个节点的**全部来源路径**与封存路径逐一比对（防伪造路径、防删漏）；
3. **逐站整段覆盖**：对每一站、每个闭包节点，取其封存采用条款，按凭证记录的规则版本复算“未撤销 + 媒介命中（`*` 通配、忽略大小写）+ 地区命中 + 有效期闭区间覆盖**该站整段**”。短授权不可拼接；不同站可用不同条款。

输出**逐站结论**（站级 `eligible`、节点级采用条款与失格原因）和累积的**篡改/失配原因**（签名不匹配、公钥不受信、规则版本/参数被改、路径伪造/删漏、边增删、媒介/地区/日期不覆盖、条款撤销等）。退出码 `0`=通过，`1`=不通过/被篡改/密钥不受信，`2`=用法或输入错误。

```bash
# 1) 馆内导出某已发布包的凭证（也可在成功发布的 201 响应里直接取 attestation）
curl -s http://<馆内地址>/api/packages/12/attestation -o attestation-pkg12.json
#   或按发布快照取：/api/attestations/by-snapshot/<snapshotId>?download=1

# 2) 馆内导出全部受信公钥（当前密钥 + 轮换前全部旧公钥，PEM 可多把同放一文件）
node scripts/attestation-keys.js export-pub trusted-pubkeys.pem
#   HTTP 等价物：GET /api/attestation-keys（返回 JSON，其中 keys[*].publicKeyPem）

# 3) 审计环境（无需数据库、无需应用代码，仅一个脚本 + 两个文件）：
node scripts/verify-attestation.js attestation-pkg12.json trusted-pubkeys.pem
#   机器可读：追加 --json；凭证也可用 - 从标准输入读；
#   不直接传公钥文件时，可用环境变量 ATTEST_TRUSTED_KEYS=<多公钥 PEM 文件>。
```

人读输出示例：

```text
结论：通过 ✅
包 #12「2026 双城巡展包」　发布快照 #7　封存场景：publish
签名：有效（kid=ed25519-…，可信密钥：是）　规则版本：1.0.0　依据版本：22
来源链复算：完整（可达节点 5 个）
逐站结论：
  第 0 站「北京首展」 屏幕放映 / 中国大陆 / 2026-03-01~2026-03-20：整段覆盖 ✅（节点 5 个）
  第 1 站「香港巡展」 沉浸式投影 / 中国香港 / 2026-05-01~2026-05-20：整段覆盖 ✅（节点 5 个）
```

任一复算不过时结论为「不通过 ❌」，并列出逐站失格节点（如 `DATE_NOT_COVERED`、`MEDIA_MISMATCH`）与顶层篡改原因（如 `SIGNATURE_INVALID`、`PATH_FORGED`、`ORPHAN_MATERIAL`、`RULE_PARAMS_MISMATCH`）。

### 本机签名密钥与轮换

密钥为 Ed25519，PEM 文件保存在 `ATTEST_KEY_DIR`（默认数据库同级 `attestation-keys/`，容器内即 `/data` 持久卷，**无需改动现有启动方式**；首次签发时惰性自动生成）：

- `attestation-ed25519-current.pem`：当前私钥（0600，勿外泄）
- `attestation-ed25519-current.pub.pem`：当前公钥
- `attestation-pubkeys.json`：公钥归档，轮换时**旧公钥永久保留**（含停用时间），旧凭证据此继续验证

```bash
node scripts/attestation-keys.js init                 # 预生成当前密钥（可选；不跑也会在首次发布时生成）
node scripts/attestation-keys.js public               # 打印当前公钥 PEM
node scripts/attestation-keys.js list                 # 查看公钥归档（JSON）
node scripts/attestation-keys.js export-pub all.pem   # 导出当前+全部历史公钥供审计方
node scripts/attestation-keys.js rotate [原因]         # 轮换：旧公钥自动归档保留
# HTTP：GET /api/attestation-keys；POST /api/attestation-keys/rotate  body {"reason":"…"}
```

轮换后：新发布用新密钥签名；**旧凭证仍用归档中的旧公钥验证**——因此审计方应使用 `export-pub` 导出的完整公钥集合；只给当前新公钥时旧凭证会报签名不匹配（符合预期）。备份时请把密钥目录与数据库**一同**安全备份。

### 升级前旧发布快照的凭证补发

升级前产生的已发布快照没有同事务凭证。可对**成功发布（eligible=1）的发布快照**申请补发：

```bash
curl -s -X POST http://<馆内地址>/api/attestations/reissue \
  -H 'Content-Type: application/json' -d '{"snapshotId": 1}'
```

补发（`sealContext:"reissue-from-snapshot"`）**只读该快照自身的 payload**，绝不查询当前授权/来源/素材来凑内容；旧快照多站节点缺少完整来源路径、或缺实际采用条款等证明所需字段时，明确拒绝：

```text
422 UNSUPPORTED_SNAPSHOT
details.missingFields = ["…nodes[materialId=…].paths", "…matchedAuthorization", …]
```

这类包需要在升级后重新核验并发布（或复制为待发布包后重新发布）才能获得凭证。对同一快照重复补发是幂等的：已封存则直接返回原凭证，不重新签名、不覆盖。

### 凭证相关 HTTP API

| 方法 路径 | 作用 |
| --- | --- |
| `POST /api/packages/:id/publish` | 发布成功（201）响应在原字段之外新增 `attestationId` 与完整 `attestation`（请求体与既有字段不变；失败仍为 422 且不产生凭证） |
| `GET /api/packages/:id` / `GET /api/packages` | 包 DTO 新增 `attestationId / attestationSnapshotId / attestationSignedBy / attestationSealContext / attestationCreatedAt`（其余字段不变） |
| `GET /api/packages/:id/attestation` | 取该包最新发布凭证（`?download=1` 带附件文件名） |
| `GET /api/attestations/by-snapshot/:snapshotId` | 按发布快照取凭证（`?download=1`） |
| `POST /api/attestations/reissue` | 旧发布快照补发（body `{"snapshotId":n}`）；已封存幂等返回；缺字段 `422 UNSUPPORTED_SNAPSHOT` |
| `GET /api/attestation-keys` | 当前密钥目录与全部受信公钥（当前 + 历史） |
| `POST /api/attestation-keys/rotate` | 轮换签名密钥（旧公钥自动保留） |

原发布请求、发布响应（除**新增**凭证字段外）与快照读取契约（`GET /api/snapshots/:id`）保持完全兼容。

## 九、目录结构

```
.
├── Dockerfile              # 依赖安装 + 数据库初始化的多阶段镜像
├── docker-compose.yml      # 一键启动（端口 3000，命名卷持久化）
├── docker-entrypoint.sh    # 可选演示数据初始化后启动
├── package.json
├── src
│   ├── db.js               # SQLite 连接、建表（含 package_stops 行程表/冻结触发器）、版本号/快照/凭证不可变触发器
│   ├── rules.js            # 核验规则确定性核心与规则版本（发布端与离线校验端共用同一套定义）
│   ├── attest-keys.js      # 本机持久化 Ed25519 密钥环：惰性生成、签名/验签、canonical JSON、轮换与公钥归档
│   ├── attest.js           # 发布凭证构建：同从事务封存完整证明要素；旧快照补发（缺字段明确拒绝）
│   ├── verify.js           # 来源链遍历、成环检测、单站/多站逐节点授权核验、发布后重算
│   ├── schedule.js         # 档期规划（仅单站；多站包明确拒绝）：起始日折算/交集/合并、事务内重验改期
│   ├── changes.js          # 单笔变更影响预演（回滚型事务模拟）与确认提交（多站影响按站给出）
│   ├── quotes.js           # 授权报价组合预览（只读）：报价校验、逐站缺口、精确最低成本集合覆盖求解
│   ├── substitutes.js      # 替代素材方案（只读预览 + 事务确认）：候选校验、去重重算、枚举三级裁决、双指纹并发防护
│   ├── batch.js            # 联展批次（只读预览 + 单事务整批发布）：逐包逐站核验、共同依据版本/双指纹凭据、整批封存或整批拒绝
│   ├── server.js           # Express API（发布同事务封存凭证、凭证导出/补发、密钥轮换、联展批次等）
│   └── seed.js             # 演示数据
├── scripts
│   ├── verify-attestation.js  # 独立离线凭证校验程序（零依赖：仅凭凭证+公钥复算签名/来源链/逐站覆盖；兼容 publish-batch）
│   └── attestation-keys.js    # 本机签名密钥管理 CLI（init/public/list/export-pub/rotate）
├── public                  # 浏览器前端（无构建；含多站行程表格编辑器、按站结果渲染、授权报价预览弹层与联展批次面板）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test/e2e.js             # 端到端业务规则自检（317 项，含多站巡展、授权报价预览、替代素材方案、发布凭证签发与离线校验、联展批次整批发布）
```
