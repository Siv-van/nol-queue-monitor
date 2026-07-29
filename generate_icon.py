from PIL import Image, ImageDraw, ImageFont
import os

# Create a 128x128 icon
size = 128
img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Draw rounded rectangle background
bg_color = (59, 130, 246, 255)  # Tailwind blue-500
radius = 24
x0, y0, x1, y1 = 4, 4, size - 4, size - 4
draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=bg_color)

# Draw "Q" text
try:
    font = ImageFont.truetype("segoeui.ttf", 72)
except:
    font = ImageFont.load_default()

text = "Q"
bbox = draw.textbbox((0, 0), text, font=font)
text_width = bbox[2] - bbox[0]
text_height = bbox[3] - bbox[1]
text_x = (size - text_width) // 2
text_y = (size - text_height) // 2 - 6

draw.text((text_x, text_y), text, font=font, fill=(255, 255, 255, 255))

# Save icon
img.save("icon.png", "PNG")
print("Icon generated: icon.png")
