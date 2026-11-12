/**
 * 主题类型定义。
 *
 * 颜色 token 对齐 AstrBot dashboard 的 PurpleTheme / PurpleThemeDark，
 * 额外保留 BusyChat 需要的容器、代码块、侧边栏 token。
 */
export interface ThemeTypes {
  name: string;
  dark: boolean;
  variables?: Record<string, string | number>;
  colors: Record<string, string>;
}
