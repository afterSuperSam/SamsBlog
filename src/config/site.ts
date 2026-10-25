export const siteConfig = {
  name: 'SamsBlog',
  description: '二次元与日常，收藏想象，也认真生活',
  siteUrl: import.meta.env.PUBLIC_SITE_URL || 'http://localhost:4321',
  locale: 'zh-CN',
  rss: { description: '只是一只大黄狗', siteUrl: 'https://blog.moesam.com/' },
  nav: [
    { href: '/', label: '首页' },
    { href: '/content', label: '内容' },
    { href: '/about', label: '关于' },
  ],
  effects: { particleCount: 60, mobileParticleCount: 18, pointerTiltDegrees: 2.5, constellation: { desktopLineCount: 10, mobileLineCount: 5, desktopPointCount: 14, mobilePointCount: 8, refreshMilliseconds: 4200, fadeMilliseconds: 1100, maximumDistanceRatio: 0.26, maximumDegree: 2, scrollPeriodScreens: 2 } },
  navigation: { sectionActivationRatio: 0.35 },
  network: { sampleCount: 3, timeoutMilliseconds: 5000 },
  sponsors: [
    { name: 'Aresgao', amount: 100 },
    { name: 'Dix2de', amount: 30 },
    { name: 'budongputong', amount: 3 },
    { name: 'fume_shroom', amount: 10 },
    { name: 'DogTable_Kcid', amount: 30 },
  ],
  sponsorPresentation: { twoColumnMinimumCount: 6, avatarSizePixels: 64, avatarBaseUrl: 'https://minotar.net/helm/', avatarTimeoutMilliseconds: 4000, avatarPreloadMarginPixels: 240 },
  sponsorFields: { nameMaximumLength: 60, maximumAmount: 1000000 },
  articles: { initialVisibleTagCount: 3, homepageCount: 1, homepageNoteCount: 2, homepageLinkCount: 1, feedCount: 20, cardCount: 3, reorderMilliseconds: 420, maximumTags: 8, tagMaximumLength: 24, searchMaximumLength: 120, searchDelayMilliseconds: 180, searchRevealMilliseconds: 280, searchDismissMilliseconds: 180 },
  articleReading: { positionStorageKey: 'sams-blog-reading-positions', preferenceStorageKey: 'sams-blog-reading-mode', fontPreferenceStorageKey: 'sams-blog-reading-font', positionLimit: 50, positionSaveMilliseconds: 1000, positionMinimumPixels: 240, imageZoomScale: 2, copyFeedbackMilliseconds: 1800, codeCollapsedLines: 16 },
  visitorProfile: { storageKey: 'sams-blog-visitor-profile', nicknameMaximumLength: 24, emailMaximumLength: 254 },
  readingExtras: { historyVisibleCount: 2, quoteMaximumCharacters: 450, quoteWidth: 1080, quoteWordmarkWidth: 210, quoteFontSize: 42, quoteLineHeight: 72, quotePadding: 88, quoteMinimumHeight: 720 },
  interactions: { feedbackResizeMilliseconds: 260, themeRevealMilliseconds: 760, keyboardInsetPixels: 18, requestTimeoutMilliseconds: 15000, tooltipDismissMilliseconds: 160, tooltipRevealMilliseconds: 180, receiptDurationMilliseconds: 1440 },
  projectPresentation: { initialVisibleCount: 4 },
  friendPresentation: { homepageCount: 6 },
  friendApplications: {
    draftStorageKey: 'sams-blog-friend-application', ownerName: 'SuperSam', iconUrl: '/media/brand/logo.jpg',
    backgroundUrl: '/uploads/2dc4ab1565c204e969aaab5618e9354cc21fdb690cef6788d5c453d8fe132edb.webp',
  },
  projectTerrain: {
    rows: 6, maximumColumns: 40, cellPixels: 60, mobileCellPixels: 48, mobileBreakpointPixels: 760,
    cameraElevationDegrees: 87, footprintRatio: 1.004, maximumHeight: 108,
    idleWaveAmplitude: 0.7, scrollWaveAmplitude: 14, wavePeriodMilliseconds: 5200, responseMilliseconds: 460, slideDistanceCells: 0.8,
    columnTransitionSpan: 0.18, centerTransitionSpan: 0.06, transitionEasingPower: 8, staggerEasingPower: 2.4, scrollWaveTurns: 1.2,
    fullVisibilityRatio: 0.1,
    framesPerSecond: 30, idleFramesPerSecond: 20, motionSettledThreshold: 0.001, pixelRatioLimit: 1.5, preloadMarginPixels: 64, seed: 47,
  },
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

const rssUrl = new URL(siteConfig.rss.siteUrl);
if (!siteConfig.friendApplications.ownerName.trim()
  || ![siteConfig.friendApplications.iconUrl, siteConfig.friendApplications.backgroundUrl].every((value) => /^\/(?!\/)[\w./-]+$/.test(value)
    && value.slice(1).split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'))) {
  throw new Error('Invalid friend application profile');
}
const sponsorAvatarUrl = new URL(siteConfig.sponsorPresentation.avatarBaseUrl);
if (sponsorAvatarUrl.protocol !== 'https:' || sponsorAvatarUrl.username || sponsorAvatarUrl.password || sponsorAvatarUrl.search || sponsorAvatarUrl.hash
  || !Number.isSafeInteger(siteConfig.sponsorPresentation.twoColumnMinimumCount) || siteConfig.sponsorPresentation.twoColumnMinimumCount < 2
  || !Number.isSafeInteger(siteConfig.sponsorPresentation.avatarSizePixels) || siteConfig.sponsorPresentation.avatarSizePixels < 16 || siteConfig.sponsorPresentation.avatarSizePixels > 256
  || ![siteConfig.sponsorPresentation.avatarTimeoutMilliseconds, siteConfig.sponsorPresentation.avatarPreloadMarginPixels].every((value) => Number.isSafeInteger(value) && value > 0)
  || !Number.isSafeInteger(siteConfig.sponsorFields.nameMaximumLength) || siteConfig.sponsorFields.nameMaximumLength < 1
  || !Number.isSafeInteger(siteConfig.sponsorFields.maximumAmount) || siteConfig.sponsorFields.maximumAmount < 1) throw new Error('Invalid sponsor configuration');
if (!siteConfig.rss.description.trim() || rssUrl.protocol !== 'https:' || rssUrl.username || rssUrl.password
  || rssUrl.pathname !== '/' || rssUrl.search || rssUrl.hash) {
  throw new Error('Invalid RSS configuration');
}
if (!Number.isSafeInteger(siteConfig.network.sampleCount) || siteConfig.network.sampleCount < 1 || siteConfig.network.sampleCount % 2 !== 1
  || !Number.isSafeInteger(siteConfig.network.timeoutMilliseconds) || siteConfig.network.timeoutMilliseconds <= 0
  || siteConfig.sponsors.some(({ name, amount }) => !name.trim() || !Number.isFinite(amount) || amount <= 0)
  || new Set(siteConfig.sponsors.map(({ name }) => name)).size !== siteConfig.sponsors.length) {
  throw new Error('Invalid network or sponsor configuration');
}

if (!Object.values(siteConfig.interactions).every((value) => Number.isSafeInteger(value) && value > 0)
  || !Number.isSafeInteger(siteConfig.articles.initialVisibleTagCount) || siteConfig.articles.initialVisibleTagCount < 1
  || !Number.isSafeInteger(siteConfig.projectPresentation.initialVisibleCount) || siteConfig.projectPresentation.initialVisibleCount < 1
  || !Number.isSafeInteger(siteConfig.friendPresentation.homepageCount) || siteConfig.friendPresentation.homepageCount < 1
  || !Object.values(siteConfig.readingExtras).every((value) => Number.isSafeInteger(value) && value > 0)
  || ![siteConfig.articleReading.positionLimit, siteConfig.articleReading.positionSaveMilliseconds, siteConfig.articleReading.positionMinimumPixels, siteConfig.articleReading.imageZoomScale, siteConfig.articleReading.copyFeedbackMilliseconds, siteConfig.articleReading.codeCollapsedLines, siteConfig.visitorProfile.nicknameMaximumLength, siteConfig.visitorProfile.emailMaximumLength].every((value) => Number.isSafeInteger(value) && value > 0)
  || !siteConfig.visitorProfile.storageKey || !siteConfig.friendApplications.draftStorageKey
  || !siteConfig.articleReading.positionStorageKey || !siteConfig.articleReading.preferenceStorageKey || !siteConfig.articleReading.fontPreferenceStorageKey) {
  throw new Error('Invalid interaction configuration');
}

const statistics = siteConfig.statistics;
const terrain = siteConfig.projectTerrain;
if (![terrain.rows, terrain.maximumColumns, terrain.cellPixels, terrain.mobileCellPixels, terrain.mobileBreakpointPixels, terrain.wavePeriodMilliseconds, terrain.responseMilliseconds, terrain.framesPerSecond, terrain.idleFramesPerSecond, terrain.preloadMarginPixels, terrain.seed].every((value) => Number.isSafeInteger(value) && value > 0)
  || terrain.rows > 40 || terrain.maximumColumns > 80 || terrain.framesPerSecond > 60 || terrain.idleFramesPerSecond > terrain.framesPerSecond
  || terrain.mobileCellPixels > terrain.cellPixels
  || !Number.isFinite(terrain.columnTransitionSpan) || terrain.columnTransitionSpan <= 0 || terrain.columnTransitionSpan >= 1
  || !Number.isFinite(terrain.centerTransitionSpan) || terrain.centerTransitionSpan <= 0 || terrain.centerTransitionSpan > terrain.columnTransitionSpan
  || !Number.isFinite(terrain.transitionEasingPower) || terrain.transitionEasingPower < 1 || terrain.transitionEasingPower > 10
  || !Number.isFinite(terrain.staggerEasingPower) || terrain.staggerEasingPower < 1 || terrain.staggerEasingPower > 5
  || !Number.isFinite(terrain.motionSettledThreshold) || terrain.motionSettledThreshold <= 0 || terrain.motionSettledThreshold > 0.1
  || !Number.isFinite(terrain.fullVisibilityRatio) || terrain.fullVisibilityRatio < 0 || terrain.fullVisibilityRatio > 0.3
  || !Number.isFinite(terrain.footprintRatio) || terrain.footprintRatio <= 0 || terrain.footprintRatio > 1.02
  || !Number.isFinite(terrain.scrollWaveTurns) || terrain.scrollWaveTurns < 0 || terrain.scrollWaveTurns > 3
  || !Number.isFinite(terrain.slideDistanceCells) || terrain.slideDistanceCells < 0 || terrain.slideDistanceCells > 5
  || !Number.isFinite(terrain.cameraElevationDegrees) || terrain.cameraElevationDegrees < 60 || terrain.cameraElevationDegrees >= 90
  || !Number.isFinite(terrain.maximumHeight) || terrain.maximumHeight <= 0 || terrain.maximumHeight > 128
  || ![terrain.idleWaveAmplitude, terrain.scrollWaveAmplitude].every((value) => Number.isFinite(value) && value >= 0 && value < terrain.maximumHeight / 2)
  || terrain.idleWaveAmplitude > terrain.scrollWaveAmplitude
  || !Number.isFinite(terrain.pixelRatioLimit) || terrain.pixelRatioLimit < 1 || terrain.pixelRatioLimit > 2) {
  throw new Error('Invalid project terrain configuration');
}

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
