interface DrawingCanvasProps {
  sketch?: boolean;
}

export function DrawingCanvas({ sketch = false }: DrawingCanvasProps) {
  return (
    <svg
      className={sketch ? 'drawing sketch' : 'drawing'}
      viewBox="0 0 320 285"
      role="img"
      aria-label={sketch ? 'Пример исходного эскиза' : 'Пример реконструкции'}
    >
      <g fill="none" stroke="currentColor">
        <path strokeWidth=".6" d="M39 32H95M39 81H74M30 182H100M55 235H112M46 32V235m-4-199 8-8m-8 57 8-8m-8 109 8-8m-8 61 8-8M100 224V262m75-47v47m110-52v52M100 254h185m-189 4 8-8m67 8 8-8m102 8 8-8M276 55h27m-25 92h25m-25 69h25M298 55v161m-4-157 8-8m-8 100 8-8m-8 77 8-8" />
        <path strokeWidth={sketch ? 1 : 4} d="M73 33h106v22h105v161H175v25h-71v-59H73V33m0 87h102V55m0 65v96m0-68h109m-180 34h71" />
        <path stroke={sketch ? 'currentColor' : '#8ab8de'} strokeWidth="1.1" d="M73 33h106v22h105v161H175v25h-71v-59H73V33m0 87h102V55m0 65v96m0-68h109m-180 34h71" />
        <path strokeWidth=".8" d="m109 120 14-15h18m79 43 14-14h18m-70-88 17-19" />
        <circle cx="204" cy="21" r="10" strokeWidth=".8" />
        <g fill="#f7f9fc" strokeWidth="1">
          <path d="M65 77h16v6H65zm57 39h18v8h-18zm48 46h10v18h-10zm53-111h18v8h-18zm-2 93h18v8h-18zm0 68h18v8h-18zm-126-13h17v7H95zm183-20h12v7h-12z" />
        </g>
      </g>
      <g fill="currentColor" fontSize="8" fontStyle={sketch ? 'italic' : undefined}>
        <text x="202" y="24">1</text>
        <text x="122" y="102">⌀32</text>
        <text x="231" y="131">⌀25</text>
        <text x="22" y="79">630</text>
        <text x="19" y="180">⌀29</text>
        <text x="266" y="141">⌀35</text>
        <text x="123" y="249">315</text>
        <text x="219" y="249">590</text>
        {sketch && <text x="139" y="16" fontSize="12">Эскиз газопровода</text>}
      </g>
    </svg>
  );
}
