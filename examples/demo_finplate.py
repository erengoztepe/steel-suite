"""İki standartla da fin plate DXF üretim demosu."""
from steeldraw.connections.finplate import FinPlate

# AISC (emperyal cıvata, AWS kaynak sembolü)
FinPlate.with_standard("AISC", bolt="3/4in", n_bolts=3).save("output/finplate_aisc.dxf", scale=5)

# Eurocode (M20, ISO kaynak sembolü)
FinPlate.with_standard("EC3", bolt="M20", n_bolts=4).save("output/finplate_ec3.dxf", scale=5)

print("İki DXF üretildi: output/finplate_aisc.dxf, output/finplate_ec3.dxf")
