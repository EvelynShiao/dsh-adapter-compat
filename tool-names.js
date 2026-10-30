/**
 * tool-names.js —— 工具中文名映射（2026-10-24 用户点名：「调用时用汉字代替不要漏名字的那种」）
 *
 * 设计约束（用户兼容性铁律）：**独立开关**（zhToolNames），关掉时零影响；
 * 中文→英文的映射只在【NL 翻译层】用——模型说「我要用工具 读取文件」
 * 时翻回真名 read 发起调用；目录展示用中文名打头（英文真名收尾保留可识别性）。
 *
 * 映射表 = 工具名直译 + 描述首词合成。没映射的工具退回英文真名（绝不丢）。
 */

/** 常用工具中文名表（宿主工具名 → 中文名）。 */
export const TOOL_ZH_NAMES = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  glob: '搜索文件名',
  grep: '搜索内容',
  pwsh: '运行PowerShell',
  ops_bash: '运行bash',
  ops_glob: '查找文件',
  ops_grep: '查找内容',
  ops_inspect_local_file: '查看文件',
  ops_replace: '替换文本',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  read_page: '阅读网页',
  x_search: '搜索推文',
  knowledge_search: '知识库检索',
  knowledge_list: '知识库列表',
  knowledge_write: '知识库写入',
  knowledge_update: '知识库更新',
  knowledge_delete: '知识库删除',
  knowledge_tags: '知识库目录',
  knowledge_vec: '知识库向量修复',
  knowledge_probe: '知识库自检',
  archives_search: '对话档案检索',
  memory_add: '记忆新增',
  memory_search: '记忆搜索',
  memory_read: '记忆读取',
  memory_update: '记忆更新',
  memory_stop: '记忆停用',
  conversation_search: '历史会话搜索',
  todo_write: '任务清单',
  ask_user_question: '向我提问',
  task_list: '任务档案列表',
  task_view: '任务查看',
  task_detail: '任务明细',
  task_inject: '任务现场恢复',
  task_update: '任务更新',
  present: '交付文件',
  interrupt_agent: '停止子代理',
  list_agents: '子代理列表',
  send_message: '发消息给代理',
  subagent: '派出子代理',
  subagent_fork: '分叉子代理',
  workflow: '批量工作流',
  get_goal: '读取目标',
  update_goal: '更新目标',
  create_goal: '创建目标',
  job_list: '后台任务列表',
  job_output: '后台任务读取',
  job_kill: '后台任务停止',
  find_dsh_plugin: '找插件',
  exit_plan_mode: '退出计划模式',
  read_image: '读图片',
  skill: '加载技能',
}

/** 英文名 → 中文名（没映射的回退英文原名的首词大写？不——原样返回英文，绝不编造）。 */
export function zhToolName(name) {
  const n = String(name ?? '')
  return TOOL_ZH_NAMES[n] ?? n
}

/**
 * 工具中文描述表（2026-10-26 用户点名「为什么还有英文工具名」——此前只加标注行，
 * 英文原文还在。此表给常用工具提供完整中文 description；egress 的 zhToolNames
 * 开启时用它【完全替换】英文 description（name 字段保留英文真名供 function calling）。
 * 没覆盖的工具退回英文原文（绝不空描述）。
 */
export const ZH_TOOL_DESCRIPTIONS = {
  read: '读取一个 UTF-8 文本文件，返回带行号的内容。可指定起始行和最大行数。',
  write: '创建或完整覆盖写入一个 UTF-8 文本文件。需要文件路径和全文内容。',
  edit: '精确替换一个 UTF-8 文本文件中的一段文字。需要文件路径、原文片段、新文本。',
  glob: '按通配符模式搜索文件名，返回匹配的文件路径列表。',
  grep: '在文件内容里搜索正则表达式，返回匹配的行和行号。',
  pwsh: '在 PowerShell 里执行命令，返回输出。适合系统操作、构建、脚本执行。',
  ops_bash: '在 bash 里执行命令，返回输出。适合管道、脚本、构建等通用命令。',
  ops_glob: '按包含和排除模式查找文件，返回文件路径列表。',
  ops_grep: '在 UTF-8 文件内容里搜索正则，返回带行号上下文的匹配。',
  ops_inspect_local_file: '查看一个 UTF-8 文本文件的有界内容或十六进制视图。',
  ops_replace: '在一个目录下按正则批量替换文本，可先试运行再实际写入。',
  web_search: '联网搜索当前信息，返回摘要和来源链接。',
  web_fetch: '抓取一个 HTTP(S) 网页并解码为纯文本。',
  read_page: '通过搜索桥阅读一个网页，返回结构化内容和要点摘要。',
  x_search: '在 X（推特）上搜索帖子、话题和讨论。',
  knowledge_search: '检索跨会话沉淀的结论卡片（第一层知识库）。',
  knowledge_list: '列出知识库的全部条目，支持游标分页。',
  knowledge_tags: '以图书馆目录树的方式逐层浏览知识库标签。',
  knowledge_write: '写入一条跨会话知识（结论卡片），立即可检索。',
  knowledge_update: '修正一条已有知识的内容、标签或重要度。',
  knowledge_delete: '删除一条知识条目。',
  knowledge_vec: '知识库向量层自检与回填修复。',
  knowledge_probe: '知识库实验套件自检验证。',
  archives_search: '深搜跨会话的原始对话片段（第二层对话档案）。',
  memory_add: '新增一条长期记忆。',
  memory_search: '搜索本地记忆库。',
  memory_read: '查看一条记忆的完整正文。',
  memory_update: '更新一条已有记忆的正文、标签或状态。',
  memory_stop: '停用一条记忆（不再召回但保留在库）。',
  conversation_search: '跨会话搜索历史对话、助手消息和工具轨迹。',
  todo_write: '记录或更新任务清单，展示多步工作的进度。',
  ask_user_question: '在继续之前向用户提一个简短的问题以确认信息。',
  task_list: '列出任务档案的摘要清单。',
  task_view: '查看一个任务的骨架：子任务、记忆项目、改动过的文件。',
  task_detail: '查看任务的某子任务的详细操作记录。',
  task_inject: '把一个任务的完整档案注入当前上下文以恢复现场。',
  task_update: '增量更新任务档案（补观察、改名、改状态）。',
  present: '把现有文件作为最终交付物呈现给用户。',
  subagent: '派出一个独立子代理完成自包含的任务。',
  subagent_fork: '分叉一个继承当前对话上下文的子代理。',
  send_message: '给一个子代理发消息以继续其对话。',
  interrupt_agent: '请求一个子代理停止当前工作。',
  list_agents: '列出当前启动的子代理及其状态。',
  workflow: '用 JavaScript 脚本批量编排子代理执行大规模任务。',
  get_goal: '读取当前会话的目标状态。',
  create_goal: '创建一个让会话跨轮持续推进的持久目标。',
  update_goal: '更新当前目标（编辑、暂停、恢复、完成、受阻）。',
  job_list: '列出后台任务及其状态。',
  job_output: '读取一个后台任务的输出。',
  job_kill: '请求停止一个正在运行的后台任务。',
  find_dsh_plugin: '在 GitHub 上搜索 DeepSeek Harness 插件。',
  exit_plan_mode: '仅在计划模式使用。把你的计划呈给用户审阅，等待批准后退出计划模式。',
  read_image: '读取一个 PNG/JPEG/WebP/GIF 图片文件并返回图像本身；大图会自动缩放。',
  skill: '加载一个技能的完整指令；在按该技能行动之前先调用它。',
}

/** 中文名 → 英文真名（NL 翻译用：模型说中文名时翻回真名）。反向查表。 */
const ZH_TO_EN = new Map(Object.entries(TOOL_ZH_NAMES).map(([en, zh]) => [zh, en]))
export function enToolName(zh) {
  const z = String(zh ?? '').trim()
  return ZH_TO_EN.get(z) ?? z
}

/**
 * 给一份工具目录（[{name, description, parameters}]）生成「中文优先」展示。
 * 返回新数组（不改原对象）：displayName = 中文名，description 前插【原名保留在 name 里】。
 */
export function localizeToolCatalog(tools) {
  return (Array.isArray(tools) ? tools : []).map((t) => {
    const zh = zhToolName(t?.name)
    return zh === t?.name ? t : { ...t, displayName: zh }
  })
}
