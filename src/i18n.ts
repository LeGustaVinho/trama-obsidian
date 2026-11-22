import am from "./locales/am.json";
import ar from "./locales/ar.json";
import be from "./locales/be.json";
import bg from "./locales/bg.json";
import bn from "./locales/bn.json";
import ca from "./locales/ca.json";
import cs from "./locales/cs.json";
import da from "./locales/da.json";
import de from "./locales/de.json";
import el from "./locales/el.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fa from "./locales/fa.json";
import fi from "./locales/fi.json";
import fr from "./locales/fr.json";
import ga from "./locales/ga.json";
import gl from "./locales/gl.json";
import he from "./locales/he.json";
import hu from "./locales/hu.json";
import id from "./locales/id.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import ka from "./locales/ka.json";
import kab from "./locales/kab.json";
import km from "./locales/km.json";
import ko from "./locales/ko.json";
import lv from "./locales/lv.json";
import ms from "./locales/ms.json";
import ne from "./locales/ne.json";
import nl from "./locales/nl.json";
import no from "./locales/no.json";
import pl from "./locales/pl.json";
import pt from "./locales/pt.json";
import pt_BR from "./locales/pt-BR.json";
import ro from "./locales/ro.json";
import ru from "./locales/ru.json";
import sa from "./locales/sa.json";
import si from "./locales/si.json";
import sk from "./locales/sk.json";
import sq from "./locales/sq.json";
import sr from "./locales/sr.json";
import sv from "./locales/sv.json";
import ta from "./locales/ta.json";
import th from "./locales/th.json";
import tr from "./locales/tr.json";
import uk from "./locales/uk.json";
import uz from "./locales/uz.json";
import vi from "./locales/vi.json";
import zh from "./locales/zh.json";
import zh_TW from "./locales/zh-TW.json";

const catalogs = {
  am, ar, be, bg, bn, ca, cs, da, de, el, en, es, fa, fi, fr, ga, gl, he, hu, id, it, ja, ka, kab, km, ko, lv, ms, ne, nl, no, pl, pt, "pt-BR": pt_BR, ro, ru, sa, si, sk, sq, sr, sv, ta, th, tr, uk, uz, vi, zh, "zh-TW": zh_TW,
  "en-GB": en,
};

export type Message = keyof typeof en;
export const supportedLocales = Object.keys(catalogs).sort();
const byCode = new Map(Object.keys(catalogs).map((code) => [code.toLowerCase(), code as keyof typeof catalogs]));
let activeLocale: keyof typeof catalogs = "en";
let numbers = new Intl.NumberFormat(activeLocale, { useGrouping: false });

export function setLocale(language: string): void {
  const code = language.trim().toLowerCase().replaceAll("_", "-");
  const aliases: Record<string, string> = { "zh-hans": "zh", "zh-hant": "zh-tw", "zh-hk": "zh-tw", "nb": "no" };
  const base = code.split("-")[0];
  activeLocale = byCode.get(code) ?? byCode.get(aliases[code] ?? aliases[base] ?? base) ?? "en";
  numbers = new Intl.NumberFormat(activeLocale, { useGrouping: false });
}

export function getLocale(): string {
  return activeLocale;
}

export function languageAttributes(): Record<"lang" | "dir", string> {
  const rtl = activeLocale === "ar" || activeLocale === "fa" || activeLocale === "he";
  return { lang: activeLocale, dir: rtl ? "rtl" : "ltr" };
}

export function formatNumber(value: number): string {
  return numbers.format(value);
}

export function t(message: Message, ...values: (string | number | undefined)[]): string {
  const catalog: Partial<Record<Message, string>> = catalogs[activeLocale];
  const template = catalog[message] ?? en[message];
  return template.replace(/\{(\d+)\}/g, (_marker, index: string) => {
    const value = values[Number(index)];
    if (typeof value === "number") return formatNumber(value);
    return value ?? "";
  });
}
