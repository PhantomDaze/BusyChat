import { defineStore } from 'pinia';

type ToastColor = 'success' | 'error' | 'warning' | 'info';

interface ToastState {
  visible: boolean;
  message: string;
  color: ToastColor;
  timeout: number;
}

/** 全局 Snackbar 提示，页面里调用 toast.success()/toast.error() 即可 */
export const useToastStore = defineStore('toast', {
  state: (): ToastState => ({
    visible: false,
    message: '',
    color: 'success',
    timeout: 2600,
  }),
  actions: {
    show(message: string, color: ToastColor = 'success', timeout = 2600) {
      this.message = message;
      this.color = color;
      this.timeout = timeout;
      this.visible = true;
    },
    success(message: string) {
      this.show(message, 'success');
    },
    error(message: string) {
      this.show(message, 'error', 4200);
    },
    warning(message: string) {
      this.show(message, 'warning', 3600);
    },
    info(message: string) {
      this.show(message, 'info');
    },
  },
});
