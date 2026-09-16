declare module 'html2text' {
  interface Options {
    wordwrap?: number | boolean;
    ignoreImage?: boolean;
    ignoreLinks?: boolean;
    preserveLinks?: boolean;
    uppercaseHeadings?: boolean;
    [key: string]: unknown;
  }
  interface Html2Text {
    parse(html: string): string;
    processSync(html: string): string;
  }
  function html2text(options?: Options): Html2Text;
  export default html2text;
}
