// User-facing text (Simplified Chinese). The product serves mainland China law
// questions, so every string shown to users or sent to the LLM lives here and the
// rest of the codebase stays English-only.
//
// `page.*` values are inserted into HTML as-is, so they may contain markup.

export interface HitLike {
  law: string;
  article_cn: string;
  zhang: string;
  bian: string;
  xiaoli: string;
  text: string;
}

export const zhCN = {
  // System prompt for the LLM; retrieved articles are appended after it.
  systemPrompt: `你是一个严谨的中国大陆法律信息检索助手。请严格依据下面提供的【检索到的法律条文】回答用户问题：
- 只依据给出的条文作答，绝不编造、杜撰法律名称、条号或内容；
- 回答中逐条注明出处，格式为《法律名称》第X条；
- 如提供的条文不足以回答，请明确说明"检索到的条文不足以回答该问题"，不要臆测；
- 用词准确、通俗，先给结论再给依据；
- 结尾附一行免责声明：本回答仅供参考，不构成正式法律意见，具体请以官方现行有效文本及专业律师意见为准。`,
  contextHeading: '【检索到的法律条文】',

  // One retrieved article as it appears in the LLM context.
  formatHit: (h: HitLike, i: number) =>
    `【${i + 1}】《${h.law}》${h.bian ? ' ' + h.bian : ''}${h.zhang ? ' ' + h.zhang : ''}（时效：${h.xiaoli}）\n${h.text}`,

  // Short citation used in the X-Legal-Hits header.
  citation: (h: HitLike) => `《${h.law}》${h.article_cn}`,

  errors: {
    codeInvalid: '邀请码无效',
    codeRevoked: '邀请码已被吊销',
    codeLimitReached: '邀请码已达使用上限',
    codeMissing: '邀请码无效或缺失',
    codeRevokedOrLimit: '邀请码已被吊销或达到使用上限',
    sessionTaken: '您的账号已在其他设备登录，请重新验证邀请码',
    deviceIdMissing: '缺少 device_id',
    retrievalFailed: (msg: string) => `检索失败: ${msg}`,
  },

  page: {
    title: '法律助手 — 中国大陆法律智能问答',
    brand: '法律助手',
    tagline: '中国大陆法律智能问答 · 基于官方法条检索',
    badge: '仅供参考 · 非法律意见',
    gatePrompt: '请输入邀请码以访问',
    gatePlaceholder: '邀请码',
    gateButton: '进入',
    welcomeTitle: '⚖️ 你好，我是法律助手',
    welcomeBody: '就中国大陆法律问题向我提问，我会检索相关法条、给出结论与依据，并逐条注明《法律名称》第X条出处。',
    coverage: '📚 试点已收录：<b>《民法典》《劳动法》《劳动合同法》《消费者权益保护法》《道路交通安全法》</b>（共 1652 条，持续扩充中）',
    disclaimer: '⚖️ 回答由 AI 基于法条检索生成，可能存在疏漏，仅供参考，不构成正式法律意见',
    inputPlaceholder: '输入你的法律问题…（Enter 发送，Shift+Enter 换行）',
    sendButton: '发送',
  },

  // Strings used by the in-page script (serialized to JSON).
  client: {
    examples: [
      '劳动合同的试用期最长可以约定多久？',
      '网购买到假货，能要求几倍赔偿？',
      '醉酒驾驶机动车会受到什么处罚？',
      '离婚时孩子的抚养权一般怎么判？',
      '公司无故拖欠工资，我该怎么办？',
    ],
    codeInvalid: '邀请码无效',
    codeReenter: '邀请码无效，请重新输入',
    verifyError: '验证出错：',
    hitsLabel: '📎 参考条文',
    httpErrorPrefix: '出错了（',
    httpErrorSuffix: '），请稍后再试',
    requestError: '请求出错：',
  },
};
