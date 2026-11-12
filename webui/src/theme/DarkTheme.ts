import type { ThemeTypes } from './ThemeType';

/** 深色主题：取 AstrBot PurpleThemeDark 的配色 */
const BusyChatDark: ThemeTypes = {
  name: 'BusyChatDark',
  dark: true,
  variables: {
    'border-color': '#3c96ca',
    'carousel-control-size': 10,
  },
  colors: {
    primary: '#5ba4d4',
    secondary: '#4a95c4',
    info: '#03c9d7',
    success: '#52c41a',
    accent: '#ffab91',
    warning: '#faad14',
    error: '#ff4d4f',
    lightprimary: '#1a2e3d',
    lightsecondary: '#1a2e3d',
    lightsuccess: '#1a3a1a',
    lighterror: '#3d1a1a',
    lightwarning: '#3d351a',
    primaryText: '#e8eaed',
    secondaryText: '#ffffffdd',
    darkprimary: '#3a8ab8',
    darksecondary: '#3a8ab8',
    borderLight: '#3a3a3a',
    border: '#333333ee',
    inputBorder: '#787878',
    containerBg: '#1a1a1a',
    surface: '#242424',
    'on-surface-variant': '#e0e0e0',
    gray100: '#cccccccc',
    primary200: '#84c9ea',
    secondary200: '#8cc4e1',
    background: '#1a1a1a',
    overlay: '#111111aa',
    codeBg: '#1f1f1f',
    preBg: 'rgb(30, 30, 30)',
    code: 'rgb(226, 226, 226)',
    mcpCardBg: '#1b2631',
  },
};

export { BusyChatDark };
