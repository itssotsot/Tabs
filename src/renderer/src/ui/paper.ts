/**
 * The filters the Paper theme draws its lines through (styles/paper.css), so outlines and icons wobble as if drawn
 * by hand: `#paper-pencil` for outlines, and the finer `#paper-wobble` for icons. Nothing uses them in other themes.
 */
export function installPaperFilters(): void {
  const rough = (id: string, frequency: number, scale: number, seed: number): string =>
    `<filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="2" seed="${seed}" result="noise"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="noise" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>` +
    `</filter>`
  document.body.insertAdjacentHTML(
    'beforeend',
    `<svg aria-hidden="true" width="0" height="0" style="position:absolute">${rough('paper-pencil', 0.03, 3.5, 7)}${rough('paper-wobble', 0.09, 1.6, 3)}</svg>`
  )
}
