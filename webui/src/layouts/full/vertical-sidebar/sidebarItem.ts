export interface NavEntry {
  title?: string;
  icon?: string;
  to?: string;
  header?: string;
  chip?: string;
}

/** 侧边栏导航：对齐 AstrBot 的「能力 / 系统」两段式分组 */
export const sidebarItems: NavEntry[] = [
  { header: 'nav.groupCapability' },
  { title: 'nav.welcome', icon: 'mdi-view-dashboard-outline', to: '/welcome' },
  { title: 'nav.providers', icon: 'mdi-creation-outline', to: '/providers' },
  { title: 'nav.plugins', icon: 'mdi-puzzle-outline', to: '/plugins' },
  { title: 'nav.knowledge', icon: 'mdi-book-open-variant', to: '/knowledge' },
  { header: 'nav.groupSystem' },
  { title: 'nav.platform', icon: 'mdi-connection', to: '/platform' },
  { title: 'nav.logs', icon: 'mdi-text-box-search-outline', to: '/logs' },
  { title: 'nav.summary', icon: 'mdi-bell-ring-outline', to: '/summary' },
  { title: 'nav.reply', icon: 'mdi-message-reply-text-outline', to: '/reply' },
  { title: 'nav.settings', icon: 'mdi-cog-outline', to: '/settings' },
];
