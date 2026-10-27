# Sistema de diseño

Todos los tokens están en `src/renderer/styles/tokens.css`. Los componentes reutilizables están en `src/renderer/components/ui.tsx`.

## Principios

- **Una sola escena memorable:** la portada procedural de cada instancia. Son paisajes de bloques de arte original, generados por código para seis biomas (sin recursos de Mojang). El resto de la interfaz es sobria: grafito, un acento y tipografía con carácter.
- **El color tiene significado.** El acento (configurable) marca la acción principal y la selección. El cian aparece solo en el progreso, es decir, cuando el launcher trabaja. Verde = en juego o correcto, ámbar = reparar o aviso, rojo = destructivo o error.
- **El estado es real.** El botón principal se calcula en el proceso principal (`primaryAction`): Jugar, Instalar, Reanudar, Reparar, En juego, Trabajando o Bloqueada. El progreso muestra bytes y archivos reales y, si no se conocen, es indeterminado. Nunca hay un porcentaje inventado.
- **Los textos explican.** Cada error dice qué pasó y qué hacer. Los estados vacíos incluyen una acción.

## Tokens

| Grupo | Valores |
|---|---|
| Color (oscuro) | `--bg #141418`, `--panel #1b1b21`, `--raised #23232b`, `--line #2f2f39`, `--text #ededf3`, `--muted #8e8ea3`, `--accent` (marca, por defecto `#8b5cf6`), `--accent-2 #22d3ee` |
| Color (claro) | redefinido bajo `[data-theme='light']` |
| Tipografía | *Bricolage Grotesque* (títulos) e *Instrument Sans* (texto), ambas OFL e incluidas localmente. Escala 12/13/15/18/24/32/46 |
| Espaciado | escala de 4 px (`--s1`…`--s12`) |
| Radios por jerarquía | control 7, panel 12, escena 18 |
| Movimiento | `--t-fast 120ms`, `--t-base 200ms`, `--t-slow 340ms`, *ease-out*. Pasan a 0 con *reducir movimiento* del sistema o con la opción «Reducidas» |

## Componentes

`Button` (primario, secundario, fantasma, peligro; tamaños; ocupado), `PlayButton`, `Field`, `Switch` (con `role=switch`), `Segmented`, `Progress` (con `role=progressbar`), `Modal` (trampa de foco, Escape, restaura el foco), `Confirm`, menú contextual, `ToastProvider` (`aria-live`), `Empty`, `Callout`, `Cover`, `Avatar` (cara de la skin real o de un maniquí original), `SkinViewer` (WebGL con alternativa 2D).

## Accesibilidad

Foco visible en todos los controles, enlace para saltar al contenido, navegación con `aria-current`, pestañas con `role=tab`, el visor 3D se gira con las flechas, contraste revisado del texto principal y secundario en ambos temas (con un acento muy claro, comprueba el contraste del texto blanco de los botones), y textos e idioma en español e inglés.

## Adaptación

Con menos de 1100 px la barra lateral se reduce a iconos. Con menos de 1000 px las rejillas pasan a una columna. La prueba E2E verifica que a 980×640 no hay desbordamiento horizontal.
