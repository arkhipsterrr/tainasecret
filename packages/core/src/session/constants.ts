export const PATHS = {
  login: '/en/users/login',
  myPage: '/en/users/mypage/',
  orders: '/en/orders',
  directPurchase: (mercariUrl: string) =>
    `/en/shoppings/mercari-direct-purchase?shopping_url=${encodeURIComponent(mercariUrl)}`,
} as const;

export const SELECTORS = {
  loginUsername: '#username',
  loginPassword: '#password',
  agreement: '#other-agreement',
  planRadios: 'input[name="Other[plan_type_tmp]"]',
  buyButton: 'input[name="order"]',
  titleField: 'input[name="Other[custom_title]"]',
} as const;
