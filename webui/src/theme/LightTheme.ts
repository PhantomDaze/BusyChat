import type { ThemeTypes } from './ThemeType';

/** 浅色主题：取 AstrBot PurpleTheme 的蓝色主色与中性色体系 */
const BusyChatLight: ThemeTypes = {
  name: 'BusyChatLight',
  dark: false,
  variables: {
    'border-color': '#3c96ca',
    'carousel-control-size': 10,
  },
  colors: {
    primary: '#3c96ca',
    secondary: '#2f86bd',
    info: '#03c9d7',
    success: '#00c853',
    accent: '#ffab91',
    warning: '#ffc107',
    error: '#f44336',
    lightprimary: '#eef2f6',
    lightsecondary: '#e8f3fa',
    lightsuccess: '#b9f6ca',
    lighterror: '#f9d8d8',
    lightwarning: '#fff8e1',
    primaryText: '#1b1c1d',
    secondaryText: '#000000aa',
    darkprimary: '#1565c0',
    darksecondary: '#236b99',
    borderLight: '#d0d0d0',
    border: '#d0d0d0',
    inputBorder: '#787878',
    containerBg: '#fffffff4',
    surface: '#ffffff',
    'on-surface-variant': '#424242',
    gray100: '#fafafacc',
    primary200: '#90caf9',
    secondary200: '#8cc4e1',
    background: '#f6f8fb',
    overlay: '#ffffffaa',
    codeBg: '#ececec',
    preBg: 'rgb(249, 249, 249)',
    code: 'rgb(13, 13, 13)',
    mcpCardBg: '#ecf2faff',
  },
};

export { BusyChatLight };
