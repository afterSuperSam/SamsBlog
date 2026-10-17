export const siteConfig = {
  name: 'SamsBlog',
  description: '二次元与日常，收藏想象，也认真生活',
  siteUrl: import.meta.env.PUBLIC_SITE_URL || 'http://localhost:4321',
  locale: 'zh-CN',
  nav: [
    { href: '/', label: '首页' },
    { href: '/about', label: '关于' },
  ],
  effects: { particleCount: 60, mobileParticleCount: 18, pointerTiltDegrees: 2.5 },
  navigation: { sectionActivationRatio: 0.35 },
  articles: { homepageCount: 2 },
  social: {
    bilibili: 'https://space.bilibili.com/390142693',
    github: 'https://github.com/afterSuperSam',
    qq: '3092243018',
  },
} as const;

if (!Number.isSafeInteger(siteConfig.articles.homepageCount) || siteConfig.articles.homepageCount < 1) {
  throw new Error('Invalid article display configuration');
}

if (!Number.isFinite(siteConfig.navigation.sectionActivationRatio) || siteConfig.navigation.sectionActivationRatio <= 0 || siteConfig.navigation.sectionActivationRatio >= 1) {
  throw new Error('Invalid section navigation configuration');
}

const { particleCount, mobileParticleCount } = siteConfig.effects;
if (!Number.isFinite(siteConfig.effects.pointerTiltDegrees) || siteConfig.effects.pointerTiltDegrees < 0 || siteConfig.effects.pointerTiltDegrees > 3) {
  throw new Error('Invalid pointer tilt configuration');
}
if (![particleCount, mobileParticleCount].every((value) => Number.isInteger(value) && value >= 0 && value <= 60) || mobileParticleCount > particleCount) {
  throw new Error('Invalid visual effects configuration');
}
