export const siteConfig = {
  name: 'SamsBlog',
  description: '二次元与日常，收藏想象，也认真生活',
  siteUrl: import.meta.env.PUBLIC_SITE_URL || 'http://localhost:4321',
  locale: 'zh-CN',
  nav: [
    { href: '/', label: '首页' },
    { href: '/about', label: '关于' },
  ],
  effects: { particleCount: 28, mobileParticleCount: 12, pointerTiltDegrees: 2.5 },
  social: {
    bilibili: 'https://space.bilibili.com/390142693',
    github: 'https://github.com/afterSuperSam',
    qq: '3092243018',
  },
} as const;

const { particleCount, mobileParticleCount } = siteConfig.effects;
if (!Number.isFinite(siteConfig.effects.pointerTiltDegrees) || siteConfig.effects.pointerTiltDegrees < 0 || siteConfig.effects.pointerTiltDegrees > 3) {
  throw new Error('Invalid pointer tilt configuration');
}
if (![particleCount, mobileParticleCount].every((value) => Number.isInteger(value) && value >= 0 && value <= 40) || mobileParticleCount > particleCount) {
  throw new Error('Invalid visual effects configuration');
}
