-- ============================================================
--  Meal Planner — add CHAAT category to your shared database
--  Paste into Supabase -> SQL Editor -> Run.  Safe to run once.
-- ============================================================

-- 1. Reclassify existing dishes that are really chaat
update dishes set "Category" = 'chaat'
  where "Dish Name" in ('Bhel Puri', 'Aloo Tikki', 'Beetroot Tikki');

-- 2. Add the new chaat dishes (skips any already present by name)
insert into dishes ("Dish Name", "Category", "Cuisine", "Season", "Is Jain", "Cooking Time", "Meal Weight", "Protein Source", "Fiber Source", "Main Ingredients", "Preference", "Recipe URL", "Notes")
select * from (values
('Aloo Tikki Chaat', 'chaat', 'Street Food', 'All Year', 'No', '30', 'Medium', 'Chickpeas', 'Potato', 'Potato, Peas, Chickpeas, Yogurt, Chutneys', 'More', '', 'Crispy potato patties with chole and chutneys'),
('Beetroot Tikki', 'chaat', 'Street Food', 'All Year', 'Yes', '30', 'Medium', '', 'Beetroot', 'Beetroot, Potato, Chaat Masala, Coriander', 'Normal', '', 'Beetroot patty chaat'),
('Ragda Pattice', 'chaat', 'Street Food', 'All Year', 'No', '40', 'Medium', 'White Peas', 'Potato', 'White Peas, Potato, Onion, Chutneys', 'Normal', '', 'Potato patties in white pea curry'),
('Sev Puri', 'chaat', 'Street Food', 'All Year', 'No', '15', 'Light', '', 'Potato', 'Puri, Potato, Onion, Sev, Chutneys', 'More', '', 'Crisp puris topped with chutneys and sev'),
('Pani Puri', 'chaat', 'Street Food', 'All Year', 'Yes', '20', 'Light', 'Mixed Sprouts', 'Potato', 'Semolina Puri, Potato, Sprouts, Tamarind Water', 'More', '', 'Crispy puris with spiced water'),
('Dahi Puri', 'chaat', 'Street Food', 'All Year', 'No', '15', 'Light', 'Yogurt', 'Potato', 'Puri, Potato, Yogurt, Sev, Chutneys', 'More', '', 'Puris filled with yogurt and chutneys'),
('Papdi Chaat', 'chaat', 'Street Food', 'All Year', 'No', '15', 'Light', 'Chickpeas', 'Yogurt', 'Papdi, Yogurt, Chickpeas, Chutneys', 'Normal', '', 'Crackers with yogurt, chickpeas and chutneys'),
('Samosa Chaat', 'chaat', 'Street Food', 'All Year', 'No', '30', 'Medium', 'Chickpeas', 'Potato', 'Samosa, Chickpeas, Yogurt, Chutneys', 'Normal', '', 'Crushed samosa topped with chole and dahi'),
('Dahi Vada', 'chaat', 'Street Food', 'All Year', 'No', '40', 'Medium', 'Urad Dal', 'Urad Dal', 'Urad Dal, Yogurt, Tamarind Chutney, Cumin', 'Normal', '', 'Soft lentil dumplings in spiced yogurt'),
('Aloo Chaat', 'chaat', 'Street Food', 'All Year', 'Yes', '20', 'Light', '', 'Potato', 'Potato, Chaat Masala, Lemon, Coriander', 'Normal', '', 'Tangy spiced potato chaat'),
('Corn Chaat', 'chaat', 'Street Food', 'Monsoon', 'Yes', '15', 'Light', 'Corn', 'Corn', 'Sweet Corn, Lemon, Chaat Masala, Coriander', 'Normal', '', 'Spiced sweet corn chaat'),
('Sprouts Chaat', 'chaat', 'Street Food', 'All Year', 'No', '15', 'Light', 'Mixed Sprouts', 'Mixed Sprouts', 'Mixed Sprouts, Onion, Tomato, Chaat Masala', 'More', '', 'Healthy sprouted bean chaat')
) as v("Dish Name", "Category", "Cuisine", "Season", "Is Jain", "Cooking Time", "Meal Weight", "Protein Source", "Fiber Source", "Main Ingredients", "Preference", "Recipe URL", "Notes")
where not exists (
  select 1 from dishes d where lower(d."Dish Name") = lower(v."Dish Name")
);
