export interface HelpSection {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    title: "快速开始",
    bullets: [
      "打开包含 WAV、FLAC 或 MP3 文件的目录。",
      "LabelAU 会递归扫描目录，并匹配同名 CSV 标注文件。",
      "从左侧任务队列选择音频，在波形或频谱中拖拽创建片段。",
      "编辑转写文本后点击“保存标注”，CSV 会写回音频同目录。",
      "完成后可在“更多”中导出 Audition 兼容的标注数据。",
    ],
  },
  {
    title: "常用操作",
    bullets: [
      "任务队列支持按未处理、未保存、已完成筛选。",
      "搜索框可按文件名或目录快速过滤音频。",
      "波形适合定位时间范围，频谱适合精细查看语音能量。",
      "右侧检查器可查看文件状态、片段统计和编辑转写。",
      "VAD、ASR 和降噪依赖外部 gRPC 引擎配置。",
    ],
  },
  {
    title: "快捷键",
    bullets: [
      "空格：播放 / 暂停",
      "S 或 Ctrl+S / Cmd+S：保存当前 CSV",
      "Ctrl+Z / Cmd+Z：撤销上一步标注",
      "M：切换到标注工具",
      "E：切换到擦除工具",
      "V：切换到拖拽查看模式",
      "X：切换线性 / MEL / 对数频率缩放",
      "R：切换播放倍率",
      "↑ / ↓：切换上一条 / 下一条音频",
      "← / →：平移当前时间窗口",
    ],
  },
  {
    title: "导出说明",
    bullets: [
      "保存标注会生成与音频同目录、同文件名的 .csv 文件。",
      "导出标注数据会读取磁盘上已保存的 CSV。",
      "存在未保存修改时，导出不会包含这些内存中的改动。",
      "导出的 CSV 保持 Audition 兼容格式，未改动现有字段规则。",
    ],
  },
];
