-- Crushed small tube ice can be split into half bags. Only block ice cannot.
update public.ice_types
set allow_half = true
where trim(name) = 'หลอดเล็กโม่';

update public.ice_types
set allow_half = false
where trim(name) in ('ก้อน', 'น้ำแข็งก้อน');
