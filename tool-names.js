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
  pwsh: '运行命令',
  ops_bash: '运行命令',
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
}

/** 英文名 → 中文名（没映射的回退英文原名的首词大写？不——原样返回英文，绝不编造）。 */
export function zhToolName(name) {
  const n = String(name ?? '')
  return TOOL_ZH_NAMES[n] ?? n
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
