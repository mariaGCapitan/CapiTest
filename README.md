# CapiTest

Exámenes tipo test para el móvil: se importa el examen de Moodle, la app crea una versión barajada para cada alumno o alumna, imprime su hoja de respuestas con nombre y código QR, y la corrige con la cámara.

## Uso

1. **Grupos**: crea el grupo y pega la lista de nombres o impórtala desde un Excel o CSV.
2. **Exámenes → Nuevo examen**: elige el módulo, el grupo y la penalización, y sube el archivo de Moodle.
3. **Imprimir**: genera el PDF. Imprímelo al 100 %, sin «ajustar a la página».
4. **Corregir**: abre la cámara y ve pasando las hojas. Revisa las preguntas en naranja (dudosas) antes de guardar.
5. **Notas**: comparte el Excel por correo. Si una pregunta estaba mal, anúlala y las notas se recalculan.

## Formatos del examen

- **Moodle XML**: banco de preguntas → Exportar → «Formato Moodle XML». Incluye las imágenes y el código (`<pre>`).
- **GIFT**: el código se escribe con `[markdown]` y bloques entre ```` ``` ````. Las llaves y los signos `= ~ # :` del texto se escapan con `\`. Las imágenes no viajan en un GIFT.

Solo se importan preguntas de opción múltiple (de 2 a 5 respuestas) y de verdadero/falso. Las demás se saltan con un aviso. En `ejemplos/` hay un archivo de cada tipo.

## Datos

Todo se guarda en el dispositivo (IndexedDB); no hay servidor. Para no perder nada, usa **Ajustes → Exportar copia**. En iPhone conviene añadir la app a la pantalla de inicio.

## Publicación

Es una web estática sin compilación: basta con servir esta carpeta por HTTPS (por ejemplo, GitHub Pages desde un repositorio público). La cámara solo funciona con HTTPS o en `localhost`.
