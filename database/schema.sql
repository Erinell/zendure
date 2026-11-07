-- Table de suivi du niveau de charge de la batterie (SOC), une ligne toutes les 10 s.
-- Base : batteries
CREATE TABLE IF NOT EXISTS soc (
  Date datetime(6) NOT NULL,
  Valeur int(11) NOT NULL,
  KEY idx_date (Date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
