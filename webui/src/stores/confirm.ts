import { defineStore } from 'pinia';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  color?: string;
}

interface ConfirmState {
  visible: boolean;
  options: ConfirmOptions;
  resolver: ((value: boolean) => void) | null;
}

const DEFAULTS: ConfirmOptions = {
  title: '',
  message: '',
  confirmText: '',
  cancelText: '',
  color: 'error',
};

/** Promise 化的确认框：`if (await confirm.ask({ message })) { ... }` */
export const useConfirmStore = defineStore('confirm', {
  state: (): ConfirmState => ({
    visible: false,
    options: { ...DEFAULTS },
    resolver: null,
  }),
  actions: {
    ask(options: ConfirmOptions): Promise<boolean> {
      // 上一个确认框还开着时直接拒绝旧 Promise，避免悬挂
      this.resolver?.(false);
      this.options = { ...DEFAULTS, ...options };
      this.visible = true;
      return new Promise<boolean>((resolve) => {
        this.resolver = resolve;
      });
    },
    resolve(value: boolean) {
      this.visible = false;
      const resolver = this.resolver;
      this.resolver = null;
      resolver?.(value);
    },
  },
});
