import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';

import { BusyChatDark } from '@/theme/DarkTheme';
import { BusyChatLight } from '@/theme/LightTheme';

/**
 * Vuetify 实例。
 *
 * 显式注册全部组件（与 AstrBot dashboard 一致），因此不依赖
 * `vite-plugin-vuetify` 的自动导入；样式在 main.ts 里引入。
 */
export default createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'BusyChatLight',
    themes: {
      BusyChatLight,
      BusyChatDark,
    },
  },
  defaults: {
    VCard: { rounded: 'lg' },
    VBtn: { rounded: 'lg' },
    VSnackbar: { elevation: 6, rounded: 'lg' },
    VTextField: { rounded: 'lg' },
    VTextarea: { rounded: 'lg' },
    VSelect: { rounded: 'lg' },
    VTooltip: { location: 'top' },
  },
});
