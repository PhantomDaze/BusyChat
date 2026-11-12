import { createPinia } from 'pinia';

/**
 * 显式导出的 Pinia 实例：路由守卫在组件树之外执行，必须用它拿 store，
 * 否则首次导航时 Pinia 尚未被 app.use() 激活。
 */
export const pinia = createPinia();
