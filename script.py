#_*_ coding: utf-8 _*_

import urllib
import urllib2
import sys
import random
import time
import mechanize
from twython import Twython
from bs4 import BeautifulSoup
from textblob import TextBlob
import requests
import re
import os
import codecs
import json as m_json

reload(sys)
sys.setdefaultencoding('utf-8')
#Initialize Twitter API, api.update_status(status=sth) is for posts
#Use OAuth2 with simplified api key/token declaring
apiKey = 'sampleKey'
apiSecret = 'sampleSecret'
accessToken = 'sampleToken'
accessTokenSecret = 'sampleTokenSecret'
api = Twython(apiKey,apiSecret,accessToken,accessTokenSecret)

#Initialize all data needed
urls = ["site1", "site2", "site3", "site4", "site5"]
copyrights = [" (sitename1)", " (sitename2)", " (sitename3)", " (sitename4)", " (sitename5)"]
mediaId = ""

source1Temp = []
source1Final = []

source2Temp = []
source2Final = []

source3Temp = []
source3Final = []

source4Temp = []
source4Final = []

source5Temp = []
source5Final = []

#Creating funcs for different sources
def source1(url):
	#Initialize stuff
	curNews = ""
	soup = BeautifulSoup(url.text, "html5lib")

	#Get unedited news file
	for title in soup.findAll('a'):
		curNews = curNews + unicode(title.string)
	

	source1Temp = curNews.split("None")

	for i in range(15, 20):
		source1Final.append(source1Temp[i])

	#This one is for test print of array
#	for i in range(len(source1Final)):
#		print(source1Final[i])	

	#Clear temp data
	#I'll add this later. I promise!

def source2(url):
	curNews = ""
	soup = BeautifulSoup(url.text, "html5lib")

	for title in soup.findAll('a'):
		curNews = curNews + unicode(title.string)

	source2Temp = curNews.split("None")

	i = 9
	while i < 14:
		source2Final.append(source2Temp[i])
		i += 1

	source2Final[len(source2Final) - 1] = source2Final[len(source2Final) - 1][:-27]
	source2Final[4] = source2Final[4][:-4]

	#Test print
#	for i in range(len(source2Final)):
#		print(source2Final[i])

#This one collects sport news 
def source3(url):
	curNews = ""
	soup = BeautifulSoup(url.text, "html5lib")

	for title in soup.findAll('a'):
		curNews = curNews + unicode(title.string)
	
	source3Temp = curNews.split("None")
	
	for i in range (5, 10):
		source3Final.append(source3Temp[i])

#	for i in range(len(source3Final)):
#		print(source3Final[i])

def source4(url):
	curNews = ""
	soup = BeautifulSoup(url.text, "html5lib")

	for title in soup.findAll('a'):
		curNews = curNews + unicode(title.string)
	
	source4Temp = curNews.split("\n")
	
	i = 22
	while i < 37:
		source4Final.append(source4Temp[i])
		i += 1

	#I'm sorry for this trash
	i = 1
	while i < 10:
		source4Final.pop(i)
		i += 2

	for i in range(1, 6):
		source4Final.pop(i)
	# The trash ends here.

	for i in range(len(source4Final)):
		source4Final[i] = source4Final[i][72:]
	
				  
#	for i in range(len(source4Final)):
#		print(source4Final[i])
		
def source5(url):
	curNews = ""
	soup = BeautifulSoup(url.text, "html5lib")
	
	for title in soup.findAll('a'):
		curNews = curNews + unicode(title.string)

	source5Temp = curNews.split("None")

	for i in range(5, 10):
		source5Final.append(source5Temp[i][1:])

#	for i in range(len(source5Final)):
#		print source5Final[i] 

#Check if storyfile contains current news
def checkPost(postText):
	flag = False
	with open("history.txt") as historyFile:
		for line in historyFile:
			if postText in line:
				flag = True
				print("History already contains this: " + postText)
				break
			else:
				flag = False
	return flag

#Getting an image for the tweet
def get_soup(url,header):
  return BeautifulSoup(urllib2.urlopen(urllib2.Request(url,headers=header)), "html5lib")

def translate(word):
	try:
		print("Keyword to translate: " + word)
		blob = TextBlob(word)
		return blob.translate(from_lang="ru", to='en')
	except:
		return "social"

def findImage(tweet):
	tweetList = tweet.split(" ")
	wordNum = random.randrange(len(tweetList))
	keyword = tweetList[wordNum]
	keywordTranslated = translate(keyword)
	print keywordTranslated
	
	#use Bing search engine 
	url = "https://www.bing.com/images/search?q="+str(keywordTranslated)  

	browser = mechanize.Browser()
        browser.set_handle_robots(False)
        browser.addheaders = [('User-agent','Mozilla')]
	urlFin = browser.open(url)

	soup = BeautifulSoup(urlFin, "html5lib")
	res = soup.findAll("a", {"class" : "thumb"})
	cur = res[0]
	print(cur['href'])
	
	urllib.urlretrieve(cur['href'], "photo.png")

#Tweeting function
def makePost():
	sourceNum = random.randrange(0, 5)
	postNum = random.randrange(0, 5)
	print("source: " + str(sourceNum) + " post: " + str(postNum))
	tweetStr = ""
	author = ""  

	if sourceNum == 0:
		source1(requests.get(urls[0]))
		tweetStr = source1Final[postNum]
		author = copyrights[0]
		findImage(tweetStr)

	elif sourceNum == 1:
		source2(requests.get(urls[1]))
		tweetStr = source2Final[postNum]
		author = copyrights[1]
		findImage(tweetStr)

	elif sourceNum == 2:
		source3(requests.get(urls[2]))
		tweetStr = source3Final[postNum]
		author = copyrights[2]
		findImage(tweetStr)

	elif sourceNum == 3:
		source4(requests.get(urls[3]))
		tweetStr = source4Final[postNum]
		author = copyrights[3]
		findImage(tweetStr)

	elif sourceNum == 4:
		source5(requests.get(urls[4]))
		tweetStr = source5Final[postNum]
		author = copyrights[4]
		findImage(tweetStr)

	else:
		print("The process of making post went wrong.")
		return
	
	res = checkPost(tweetStr)
	print ("Flag value: " + str(res))
	if res == True:
		print("News has already been posted. Searching for another news.")
	elif res == False:
		toTweet = tweetStr + author
		photo = open("photo.png", "rb")
		api.update_status_with_media(status = toTweet, media = photo)
		with codecs.open("history.txt", "a", "utf-8-sig") as log:
			log.write(tweetStr + "\n")
		print("Tweet posted: " + toTweet)
		time.sleep(1800)
		makePost()

#And here we go!
while True:
	try:
		makePost()
	except:
		print("An error occured")
		continue


