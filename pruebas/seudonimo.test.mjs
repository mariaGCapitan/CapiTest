// node pruebas/seudonimo.test.mjs
import assert from 'node:assert/strict';
import { checkList, isPseudonym, parseSeneca, toPseudonym } from '../js/seudonimo.js';

const eq = (name, value) => assert.equal(toPseudonym(name).value, value, name);
eq('García López, Ana', 'GAR. LÓP., A.');
eq('GARCÍA LÓPEZ, ANA MARÍA', 'GAR. LÓP., A.');
eq('garcía lópez, ana', 'GAR. LÓP., A.');
eq('Ñáñez Úbeda, Óscar', 'ÑÁÑ. ÚBE., Ó.');
eq('Ruz Li, Eva', 'RUZ. LI., E.');
eq('De la Torre Ruiz, Luis', 'TOR. RUI., L.');
eq('Ruiz de la Torre, Luis', 'RUI. TOR., L.');
eq('García-Pérez Ruiz, Ana', 'GAR. PÉR., A.');
eq('Nguyen, Linh', 'NGU., L.');
eq('  García   López ,  Ana ', 'GAR. LÓP., A.');
eq("O'Connor Ruiz, Sean", 'OCO. RUI., S.');
eq('GAR. LÓP., A.', 'GAR. LÓP., A.');
eq('GAR. LÓP., A.2', 'GAR. LÓP., A.2');
assert.ok(toPseudonym('Ana García López').error);
assert.ok(toPseudonym('García López,').error);
assert.ok(toPseudonym(', Ana').error);
assert.ok(toPseudonym('').error);
assert.ok(isPseudonym('MOR. BER., J.'));
assert.ok(!isPseudonym('Moral, J.'));

const dup = checkList(['García López, Ana', 'Garrido López, Alba', 'Ruiz Sanz, Eva']);
assert.ok(dup[0].error && dup[1].error && !dup[2].error);
const have = checkList(['Ruiz Sanz, Eva', 'Ruiz Sanz, Luis'], ['RUI. SAN., E.']);
assert.ok(have[0].existing && !have[1].existing);
const seneca = [['Título:', 'MIS ALUMNOS Y ALUMNAS'], ['Autor:', 'Aplicación Séneca'], ['Fecha de creación:', '01/01/2027'], ['', ''],
  ['Alumno', 'Cuenta Google/Microsoft'], ['García López, Ana', 'correo1@ejemplo.es'], [' Ruiz Sanz, Eva ', 'correo2@ejemplo.es'], ['', '']];
assert.deepEqual(parseSeneca(seneca), ['García López, Ana', 'Ruiz Sanz, Eva']);
assert.equal(parseSeneca([['Nombre', 'Nota'], ['Ana', 5]]), null);
assert.equal(parseSeneca([['Alumno', 'Cuenta Google/Microsoft']]), null);
console.log('ok');
