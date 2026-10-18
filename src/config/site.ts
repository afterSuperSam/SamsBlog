export const siteConfig = {
  name: 'SamsBlog',
  description: '二次元与日常，收藏想象，也认真生活',
  siteUrl: import.meta.env.PUBLIC_SITE_URL || 'http://localhost:4321',
  locale: 'zh-CN',
  registration: { label: '萌ICP备20269090号', href: 'https://icp.gov.moe/?keyword=20269090' },
  nav: [
    { href: '/', label: '首页' },
    { href: '/about', label: '关于' },
  ],
  effects: { particleCount: 60, mobileParticleCount: 18, pointerTiltDegrees: 2.5, constellation: { desktopLineCount: 10, mobileLineCount: 5, desktopPointCount: 14, mobilePointCount: 8, refreshMilliseconds: 4200, fadeMilliseconds: 1100, maximumDistanceRatio: 0.26, maximumDegree: 2, scrollPeriodScreens: 2 } },
  navigation: { sectionActivationRatio: 0.35 },
  articles: { homepageCount: 2, feedCount: 20, cardCount: 3, reorderMilliseconds: 420 },
  articleReading: { positionStorageKey: 'sams-blog-reading-positions', preferenceStorageKey: 'sams-blog-reading-mode', positionLimit: 50, positionSaveMilliseconds: 1000, positionMinimumPixels: 240, imageZoomScale: 2, copyFeedbackMilliseconds: 1800 },
  interactions: { feedbackResizeMilliseconds: 260, themeRevealMilliseconds: 760, monthScrollMilliseconds: 360, keyboardInsetPixels: 18 },
  projectPresentation: { initialVisibleCount: 4 },
  projects: [
    { repository: 'afterSuperSam/SamsTownWeb', name: 'SamsTownWeb', description: '楹雾镇 Minecraft 社区网站', keyword: '楹雾', status: 'active' },
    { repository: 'afterSuperSam/FlayerBot', name: 'FlayerBot', description: '单进程 Minecraft 自动化 Bot', keyword: 'Bot', status: 'maintenance' },
    { repository: 'afterSuperSam/SamsBlog', name: 'SamsBlog', description: '夏日插画风的个人项目与日常站点', keyword: '站点', status: 'active' },
    { repository: 'afterSuperSam/ItemsaddderConfigGenerator', name: 'ItemsAdder 配置生成器', description: '批量生成普通 2D 材质的配置文件', keyword: '材质', status: 'archived' },
  ],
  currentWork: { defaultText: '最近在做：YetAnotherTown', maximumLength: 80 },
  projectFields: { nameMaximumLength: 60, descriptionMaximumLength: 240, urlMaximumLength: 2048, keywordMaximumLength: 60, repositoryMaximumLength: 200 },
  statistics: { countDurationMilliseconds: 1400, countStaggerMilliseconds: 90, easingPower: 3, visibilityThreshold: 0.35 },
  reveal: { durationMilliseconds: 620, distancePixels: 24, itemStaggerMilliseconds: 75, maximumStaggerMilliseconds: 225, characterDurationMilliseconds: 580, characterStaggerMilliseconds: 48, visibilityThreshold: 0.08, bottomInsetPercent: 6 },
  signature: { durationMilliseconds: 1000, strokePauseMilliseconds: 12, visibilityThreshold: 0.45, easing: 'ease-in-out', settleDurationMilliseconds: 560, versionCharacterDurationMilliseconds: 360, versionCharacterStaggerMilliseconds: 45 },
  social: {
    bilibili: 'https://space.bilibili.com/390142693',
    github: 'https://github.com/afterSuperSam',
    qq: '3092243018',
  },
} as const;

const registrationUrl = new URL(siteConfig.registration.href);
if (!siteConfig.registration.label.trim() || registrationUrl.protocol !== 'https:' || registrationUrl.username || registrationUrl.password) {
  throw new Error('Invalid registration configuration');
}

if (!Object.values(siteConfig.interactions).every((value) => Number.isSafeInteger(value) && value > 0)
  || !Number.isSafeInteger(siteConfig.projectPresentation.initialVisibleCount) || siteConfig.projectPresentation.initialVisibleCount < 1
  || ![siteConfig.articleReading.positionLimit, siteConfig.articleReading.positionSaveMilliseconds, siteConfig.articleReading.positionMinimumPixels, siteConfig.articleReading.imageZoomScale, siteConfig.articleReading.copyFeedbackMilliseconds].every((value) => Number.isFinite(value) && value > 0)
  || !siteConfig.articleReading.positionStorageKey || !siteConfig.articleReading.preferenceStorageKey) {
  throw new Error('Invalid interaction configuration');
}

const statistics = siteConfig.statistics;
if (!Number.isSafeInteger(statistics.countDurationMilliseconds) || statistics.countDurationMilliseconds <= 0
  || !Number.isSafeInteger(statistics.countStaggerMilliseconds) || statistics.countStaggerMilliseconds < 0
  || !Number.isFinite(statistics.easingPower) || statistics.easingPower < 1 || statistics.easingPower > 5
  || !Number.isFinite(statistics.visibilityThreshold) || statistics.visibilityThreshold <= 0 || statistics.visibilityThreshold > 1) {
  throw new Error('Invalid statistics animation configuration');
}

const reveal = siteConfig.reveal;
if (![reveal.durationMilliseconds, reveal.characterDurationMilliseconds].every((value) => Number.isSafeInteger(value) && value > 0)
  || ![reveal.distancePixels, reveal.itemStaggerMilliseconds, reveal.maximumStaggerMilliseconds, reveal.characterStaggerMilliseconds].every((value) => Number.isSafeInteger(value) && value >= 0)
  || !Number.isFinite(reveal.visibilityThreshold) || reveal.visibilityThreshold <= 0 || reveal.visibilityThreshold > 1
  || !Number.isFinite(reveal.bottomInsetPercent) || reveal.bottomInsetPercent < 0 || reveal.bottomInsetPercent >= 100) {
  throw new Error('Invalid reveal animation configuration');
}

if (!Object.values(siteConfig.articles).every((value) => Number.isSafeInteger(value) && value > 0)) {
  throw new Error('Invalid article display configuration');
}

if (!Number.isSafeInteger(siteConfig.currentWork.maximumLength) || siteConfig.currentWork.maximumLength < 1
  || !Object.values(siteConfig.projectFields).every((value) => Number.isSafeInteger(value) && value > 0)
  || siteConfig.currentWork.defaultText.length > siteConfig.currentWork.maximumLength
  || new Set(siteConfig.projects.map((project) => project.repository)).size !== siteConfig.projects.length
  || siteConfig.projects.some((project) => !/^[\w.-]+\/[\w.-]+$/.test(project.repository)
    || !project.keyword || !project.description.includes(project.keyword)
    || !['active', 'maintenance', 'archived'].includes(project.status))) {
  throw new Error('Invalid project configuration');
}

const { durationMilliseconds, strokePauseMilliseconds, visibilityThreshold, easing, settleDurationMilliseconds, versionCharacterDurationMilliseconds, versionCharacterStaggerMilliseconds } = siteConfig.signature;
if (!Number.isSafeInteger(durationMilliseconds) || durationMilliseconds < 1
  || !Number.isSafeInteger(strokePauseMilliseconds) || strokePauseMilliseconds < 0
  || !Number.isFinite(visibilityThreshold) || visibilityThreshold <= 0 || visibilityThreshold > 1
  || !['linear', 'ease-in', 'ease-out', 'ease-in-out'].includes(easing)
  || ![settleDurationMilliseconds, versionCharacterDurationMilliseconds].every((value) => Number.isSafeInteger(value) && value > 0)
  || !Number.isSafeInteger(versionCharacterStaggerMilliseconds) || versionCharacterStaggerMilliseconds < 0) {
  throw new Error('Invalid signature animation configuration');
}

if (!Number.isFinite(siteConfig.navigation.sectionActivationRatio) || siteConfig.navigation.sectionActivationRatio <= 0 || siteConfig.navigation.sectionActivationRatio >= 1) {
  throw new Error('Invalid section navigation configuration');
}

const { particleCount, mobileParticleCount } = siteConfig.effects;
const constellation = siteConfig.effects.constellation;
if (![constellation.desktopLineCount, constellation.mobileLineCount, constellation.desktopPointCount, constellation.mobilePointCount, constellation.maximumDegree].every((value) => Number.isSafeInteger(value) && value > 0)
  || constellation.desktopPointCount > particleCount || constellation.mobilePointCount > mobileParticleCount
  || constellation.mobileLineCount > constellation.desktopLineCount || constellation.maximumDegree > 3
  || constellation.desktopLineCount > constellation.desktopPointCount * constellation.maximumDegree / 2
  || constellation.mobileLineCount > constellation.mobilePointCount * constellation.maximumDegree / 2
  || ![constellation.refreshMilliseconds, constellation.fadeMilliseconds].every((value) => Number.isSafeInteger(value) && value > 0)
  || constellation.refreshMilliseconds <= constellation.fadeMilliseconds * 2
  || !Number.isFinite(constellation.maximumDistanceRatio) || constellation.maximumDistanceRatio <= 0 || constellation.maximumDistanceRatio > 1
  || !Number.isFinite(constellation.scrollPeriodScreens) || constellation.scrollPeriodScreens <= 0) {
  throw new Error('Invalid constellation configuration');
}
if (!Number.isFinite(siteConfig.effects.pointerTiltDegrees) || siteConfig.effects.pointerTiltDegrees < 0 || siteConfig.effects.pointerTiltDegrees > 3) {
  throw new Error('Invalid pointer tilt configuration');
}
if (![particleCount, mobileParticleCount].every((value) => Number.isInteger(value) && value >= 0 && value <= 60) || mobileParticleCount > particleCount) {
  throw new Error('Invalid visual effects configuration');
}
