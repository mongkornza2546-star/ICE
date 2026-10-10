import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { legacyUiTranslations } from './legacyUiTranslations';

export type AppLanguage = 'th' | 'my';

const STORAGE_KEY = 'ice-delivery.language.v1';
const THAI_TITLE = 'ระบบจัดส่งน้ำแข็งศูนย์ราชการ';
const MYANMAR_TITLE = 'အစိုးရရုံးဌာန ရေခဲပို့ဆောင်ရေးစနစ်';

export const messages = {
  language: { th: 'ภาษา', my: 'ဘာသာစကား' },
  thai: { th: 'ไทย', my: 'ထိုင်း' },
  myanmar: { th: 'မြန်မာ', my: 'မြန်မာ' },
  signIn: { th: 'เข้าสู่ระบบ', my: 'အကောင့်ဝင်ရန်' },
  signingIn: { th: 'กำลังเข้าสู่ระบบ...', my: 'အကောင့်ဝင်နေသည်...' },
  signOut: { th: 'ออกจากระบบ', my: 'အကောင့်ထွက်ရန်' },
  usernameOrEmail: { th: 'ชื่อเล่นหรืออีเมล', my: 'အမည်ပြောင် သို့မဟုတ် အီးမေးလ်' },
  usernameExample: { th: 'เช่น เมย์ หรือ staff@example.com', my: 'ဥပမာ May သို့မဟုတ် staff@example.com' },
  password: { th: 'รหัสผ่าน', my: 'စကားဝှက်' },
  loginTitle: { th: 'เข้าสู่ระบบหน้างาน', my: 'လုပ်ငန်းခွင်စနစ်သို့ ဝင်ရန်' },
  brand: { th: 'ส่งน้ำแข็ง', my: 'ရေခဲပို့ဆောင်ရေး' },
  brandFull: { th: 'ระบบจัดส่งน้ำแข็ง', my: 'ရေခဲပို့ဆောင်ရေးစနစ်' },
  employeePage: { th: 'หน้าพนักงาน', my: 'ဝန်ထမ်းစာမျက်နှာ' },
  demoMode: { th: 'Local Demo Mode', my: 'နမူနာစနစ်' },
  demoDescription: { th: 'โหมดนี้ใช้ข้อมูลจำลองในเบราว์เซอร์ ไม่แตะ Supabase จริง: รับน้ำแข็งจากรถเข้ารถเข็น เลือกร้าน แล้วใส่จำนวนที่ส่งแต่ละชนิด', my: 'ဤပုံစံသည် ဘရောက်ဆာအတွင်း နမူနာအချက်အလက်ကိုသာ သုံးပြီး Supabase အစစ်ကို မထိပါ။ ကားမှ ရေခဲလက်ခံ၊ ဆိုင်ရွေးပြီး ပို့မည့်အရေအတွက် ထည့်ပါ' },
  loading: { th: 'กำลังโหลด...', my: 'ဖွင့်နေသည်...' },
  booting: { th: 'กำลังเริ่มระบบ', my: 'စနစ် စတင်နေသည်' },
  loadingSession: { th: 'โหลด session และสิทธิ์ผู้ใช้', my: 'အသုံးပြုသူအကောင့်နှင့် ခွင့်ပြုချက်များကို စစ်ဆေးနေသည်' },
  setupRequired: { th: 'ต้องตั้งค่า Supabase ก่อนเริ่มใช้หน้าพนักงาน', my: 'ဝန်ထမ်းစာမျက်နှာ မသုံးမီ Supabase ကို သတ်မှတ်ရန် လိုအပ်သည်' },
  setupFile: { th: 'สร้างไฟล์', my: 'ဖိုင်တစ်ခု ဖန်တီးပါ' },
  setupFrom: { th: 'จาก', my: 'မှ' },
  setupThen: { th: 'แล้วใส่', my: 'ထို့နောက် ထည့်ပါ' },
  setupAnd: { th: 'และ', my: 'နှင့်' },
  loadingPermissions: { th: 'กำลังโหลดสิทธิ์', my: 'ခွင့်ပြုချက်များ ဖွင့်နေသည်' },
  checkingUser: { th: 'ตรวจข้อมูลผู้ใช้ในระบบ', my: 'အသုံးပြုသူအချက်အလက် စစ်ဆေးနေသည်' },
  userLoadFailed: { th: 'โหลดผู้ใช้ไม่สำเร็จ', my: 'အသုံးပြုသူကို ဖွင့်မရပါ' },
  accountInactive: { th: 'บัญชียังไม่พร้อมใช้งาน', my: 'အကောင့် အသုံးပြုရန် မရသေးပါ' },
  accountNotEnabled: { th: 'ผู้ดูแลยังไม่ได้เปิดสิทธิ์บัญชีนี้', my: 'စီမံခန့်ခွဲသူက ဤအကောင့်ကို မဖွင့်ရသေးပါ' },
  accountAuthCreated: { th: 'บัญชี Supabase Auth ถูกสร้างแล้ว แต่ `public.users.is_active` ยังเป็น `false`', my: 'Supabase Auth အကောင့်ကို ဖန်တီးပြီးဖြစ်သော်လည်း `public.users.is_active` သည် `false` ဖြစ်နေဆဲဖြစ်သည်' },
  saveInProgress: { th: 'กำลังบันทึกรายการ', my: 'မှတ်တမ်း သိမ်းဆည်းနေသည်' },
  unsavedConfirm: { th: 'ยังไม่ได้บันทึกรายการนี้ ต้องการออกจากหน้านี้หรือไม่?', my: 'ဤမှတ်တမ်းကို မသိမ်းရသေးပါ။ ဤစာမျက်နှာမှ ထွက်လိုပါသလား။' },
  managerMenu: { th: 'เมนูหัวหน้า', my: 'ကြီးကြပ်ရေးမှူး မီနူး' },
  menu: { th: 'เมนู', my: 'မီနူး' },
  closeMenu: { th: 'ปิดเมนู', my: 'မီနူးပိတ်ရန်' },
  notifications: { th: 'การแจ้งเตือน', my: 'အသိပေးချက်များ' },
  today: { th: 'วันนี้', my: 'ယနေ့' },
  governmentCenter: { th: 'ศูนย์ราชการ', my: 'အစိုးရရုံးဌာန' },
  serviceDate: { th: 'วันที่ออกบิล', my: 'ဘေလ်ထုတ်သည့်ရက်' },
  workToday: { th: 'งานวันนี้', my: 'ယနေ့လုပ်ငန်း' },
  executiveReports: { th: 'รายงานผู้บริหาร', my: 'အုပ်ချုပ်ရေး အစီရင်ခံစာ' },
  reports: { th: 'รายงาน', my: 'အစီရင်ခံစာများ' },
  events: { th: 'งานอีเวนต์', my: 'ပွဲအစီအစဉ်လုပ်ငန်း' },
  eventShort: { th: 'อีเวนต์', my: 'ပွဲအစီအစဉ်' },
  factoryOrder: { th: 'สั่งน้ำแข็งจากโรงงาน', my: 'စက်ရုံမှ ရေခဲမှာယူရန်' },
  factoryOrderShort: { th: 'สั่งน้ำแข็ง', my: 'ရေခဲမှာယူရန်' },
  delivery: { th: 'บันทึกส่งน้ำแข็ง', my: 'ရေခဲပို့ဆောင်မှု မှတ်တမ်း' },
  deliveryShort: { th: 'บันทึกส่ง', my: 'ပို့ဆောင်မှုမှတ်တမ်း' },
  finance: { th: 'การเงินและบัญชี', my: 'ငွေကြေးနှင့် စာရင်းကိုင်' },
  financeShort: { th: 'การเงิน', my: 'ငွေကြေး' },
  stockOperations: { th: 'โอน / ตรวจ / ปิดสต๊อก', my: 'ကုန်လက်ကျန် လွှဲ / စစ် / ပိတ်' },
  stockOperationsShort: { th: 'จัดการสต๊อก', my: 'ကုန်လက်ကျန် စီမံရန်' },
  stockAudit: { th: 'Audit สต็อก', my: 'ကုန်လက်ကျန် စစ်ဆေးမှု' },
  locations: { th: 'สถานที่และจุดถือครอง', my: 'တည်နေရာနှင့် သိုလှောင်ရာနေရာများ' },
  locationsShort: { th: 'สถานที่', my: 'တည်နေရာများ' },
  shops: { th: 'ร้านค้า', my: 'ဆိုင်များ' },
  systemData: { th: 'ผู้ใช้และชนิดน้ำแข็ง', my: 'အသုံးပြုသူများနှင့် ရေခဲအမျိုးအစားများ' },
  systemDataShort: { th: 'ข้อมูลระบบ', my: 'စနစ်အချက်အလက်' },
  collectShopPayments: { th: 'เก็บเงินร้านค้า', my: 'ဆိုင်များမှ ငွေကောက်ခံရန်' },
  accountingDocuments: { th: 'บัญชี / เอกสารและการเงิน', my: 'စာရင်းကိုင် / စာရွက်စာတမ်းနှင့် ငွေကြေး' },
  creditReceivables: { th: 'ลูกหนี้เครดิต', my: 'အကြွေးကျန် ဖောက်သည်များ' },
  creditSignoff: { th: 'ใบเซ็นเครดิต', my: 'အကြွေးလက်မှတ်စာရွက်' },
  employeeTasks: { th: 'งานพนักงาน', my: 'ဝန်ထမ်းလုပ်ငန်းများ' },
  stockReceiveReturn: { th: 'เติม / คืน / ละลาย', my: 'ဖြည့် / ပြန်ပို့ / အရည်ပျော်' },
  collectMoney: { th: 'เก็บเงิน', my: 'ငွေကောက်ခံရန်' },
  roleByDatabase: { th: 'สิทธิ์ตามบทบาท', my: 'အခန်းကဏ္ဍအလိုက် ခွင့်ပြုချက်' },
  verifiedByDatabase: { th: 'ตรวจสอบโดยฐานข้อมูล', my: 'ဒေတာဘေ့စ်မှ စစ်ဆေးထားသည်' },
  financialSubmenu: { th: 'เมนูย่อยการเงินและบัญชี', my: 'ငွေကြေးနှင့် စာရင်းကိုင် မီနူးခွဲ' },
  genericError: { th: 'เกิดข้อผิดพลาด กรุณาลองใหม่', my: 'အမှားတစ်ခု ဖြစ်ပွားခဲ့သည်။ ထပ်မံကြိုးစားပါ။' },
} as const;

export type MessageKey = keyof typeof messages;

function readLanguage(): AppLanguage {
  if (typeof window === 'undefined') return 'th';
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'my' ? 'my' : 'th';
  } catch {
    return 'th';
  }
}

let activeLanguage: AppLanguage = readLanguage();

export function getActiveLanguage() {
  return activeLanguage;
}

export function translateUi(source: string, values?: Record<string, string | number>) {
  const key = source.trim();
  const copy = activeLanguage === 'my' && legacyUiTranslations[key]
    ? source.replace(key, legacyUiTranslations[key]) : source;
  // Substitute only after translating the UI template. Values are business data.
  return values ? copy.replace(/\{(\w+)\}/g, (token, key: string) => String(values[key] ?? token)) : copy;
}

export function localizeErrorMessage(message: string): string {
  if (activeLanguage === 'th') return message;
  if (/jwt has expired|invalid refresh token|refresh token.*not found|เซสชันหมดอายุ/i.test(message)) {
    return 'အကောင့်ဝင်ချိန် သက်တမ်းကုန်သွားပါပြီ။ ထပ်မံဝင်ပါ။';
  }
  if (/jwt issued at future|เวลาในเครื่องหรือเซสชัน/i.test(message)) {
    return 'စက်၏ ရက်စွဲနှင့် အချိန်ကို စစ်ဆေးပြီး ထပ်မံဝင်ပါ။';
  }
  if (/invalid login credentials|invalid email or password|รหัสผ่านไม่ถูกต้อง/i.test(message)) {
    return 'အသုံးပြုသူအမည် သို့မဟုတ် စကားဝှက် မမှန်ပါ။';
  }
  if (/failed to fetch|network|offline|เครือข่าย|เชื่อมต่อ/i.test(message)) {
    return 'ကွန်ရက်ချိတ်ဆက်မှုကို စစ်ဆေးပြီး ထပ်မံကြိုးစားပါ။';
  }
  if (/permission|not authorized|forbidden|ไม่ได้รับสิทธิ์/i.test(message)) {
    return 'ဤလုပ်ဆောင်ချက်အတွက် ခွင့်ပြုချက် မရှိပါ။';
  }
  return messages.genericError.my;
}

export function uiDateTimeFormat(options: Intl.DateTimeFormatOptions, thaiLocale = 'th-TH'): Intl.DateTimeFormat {
  const bangkokOptions = { timeZone: 'Asia/Bangkok', ...options };
  const thai = new Intl.DateTimeFormat(thaiLocale, bangkokOptions);
  // en-GB fixes Gregorian years and Latin digits even in browsers with incomplete my-MM ICU data.
  const myanmar = new Intl.DateTimeFormat('en-GB', { ...bangkokOptions, calendar: 'gregory', numberingSystem: 'latn' });
  const monthNames: Record<string, string> = {
    January: 'ဇန်နဝါရီ', Jan: 'ဇန်', February: 'ဖေဖော်ဝါရီ', Feb: 'ဖေ',
    March: 'မတ်', Mar: 'မတ်', April: 'ဧပြီ', Apr: 'ဧ', May: 'မေ',
    June: 'ဇွန်', Jun: 'ဇွန်', July: 'ဇူလိုင်', Jul: 'ဇူ', August: 'ဩဂုတ်', Aug: 'ဩ',
    September: 'စက်တင်ဘာ', Sept: 'စက်', Sep: 'စက်', October: 'အောက်တိုဘာ', Oct: 'အောက်',
    November: 'နိုဝင်ဘာ', Nov: 'နို', December: 'ဒီဇင်ဘာ', Dec: 'ဒီ',
    Monday: 'တနင်္လာ', Mon: 'တနင်္လာ', Tuesday: 'အင်္ဂါ', Tue: 'အင်္ဂါ',
    Wednesday: 'ဗုဒ္ဓဟူး', Wed: 'ဗုဒ္ဓဟူး', Thursday: 'ကြာသပတေး', Thu: 'ကြာသပတေး',
    Friday: 'သောကြာ', Fri: 'သောကြာ', Saturday: 'စနေ', Sat: 'စနေ',
    Sunday: 'တနင်္ဂနွေ', Sun: 'တနင်္ဂနွေ',
  };
  const localizeDate = (value: string) => value.replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Sept|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g, (part) => monthNames[part] ?? part);
  return new Proxy(thai, {
    get(_target, property) {
      const formatter = activeLanguage === 'my' ? myanmar : thai;
      if (formatter === myanmar && property === 'format') return (value: Date | number) => localizeDate(myanmar.format(value));
      if (formatter === myanmar && property === 'formatToParts') return (value: Date | number) => myanmar.formatToParts(value).map((part) => ({ ...part, value: localizeDate(part.value) }));
      const value = Reflect.get(formatter, property);
      return typeof value === 'function' ? value.bind(formatter) : value;
    },
  });
}

export function uiDateTimeString(date: Date, options?: Intl.DateTimeFormatOptions): string {
  if (activeLanguage === 'th') return date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', ...options });
  return uiDateTimeFormat({ dateStyle: 'short', timeStyle: 'medium', ...options }).format(date);
}

type LanguageContextValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  t: (key: MessageKey) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);
const thaiContext: LanguageContextValue = {
  language: 'th',
  setLanguage: () => undefined,
  t: (key) => messages[key].th,
};

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguage>(readLanguage);
  activeLanguage = language;

  const setLanguage = (next: AppLanguage) => {
    activeLanguage = next;
    setLanguageState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The current tab still changes language when browser storage is unavailable.
    }
  };

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === 'my' ? MYANMAR_TITLE : THAI_TITLE;
  }, [language]);

  const value = useMemo<LanguageContextValue>(() => ({
    language,
    setLanguage,
    t: (key) => messages[key][language],
  }), [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  return value ?? thaiContext;
}

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { language, setLanguage, t } = useLanguage();
  return (
    <label className={`language-switcher ${className}`.trim()}>
      <span className="sr-only">{t('language')}</span>
      <select aria-label={t('language')} onChange={(event) => setLanguage(event.target.value as AppLanguage)} value={language}>
        <option value="th">ไทย</option>
        <option value="my">မြန်မာ</option>
      </select>
    </label>
  );
}

export const uiDateLocale = (language: AppLanguage) => language === 'my'
  ? 'my-MM-u-ca-gregory-nu-latn'
  : 'th-TH';

export const uiNumberLocale = (language: AppLanguage) => language === 'my'
  ? 'my-MM-u-nu-latn'
  : 'th-TH';
